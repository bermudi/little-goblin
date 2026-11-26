import { convertToModelMessages, type ToolSet } from "ai";
import type { PromptMessage } from "../prompt-message.ts";
import { toToolSet } from "./ai-sdk-tools.ts";
import type { Tools } from "../tool.ts";
import type { Message } from "../message.ts";
import {
	INLINE_ITEM_MAX_BYTES,
	type MediaPosition,
	materializeAttachments,
} from "../agent/attachments.ts";
import { log } from "../log.ts";
import { inlineMentions } from "../inline-parts.ts";
import { messageText, type RecallContext, withMemoryBlocks } from "../memory/mod.ts";
import { CONTEXT_PART, contextPartDataSchema, contextText } from "../message-context.ts";
import { NOTE_PART, noteFence, notePartDataSchema } from "../notes.ts";
import {
	SKILL_PART,
	isTempSkillRef,
	skillMarkerText,
	skillPartDataSchema,
	tempSkillMarkerText,
	type SkillRef,
} from "../skill-part.ts";

export interface ViewContext {
	convId: string;
	modelRef: string;
	tools: Tools;
	sdkTools?: ToolSet;
	modalities: Set<string> | undefined;
	carries: (mediaType: string, position: MediaPosition) => boolean;
	keepProviderExecuted?: boolean;
	skillRef: (
		ref: SkillRef,
		includeBody: boolean,
	) => { name: string; body: string | null; source?: string; skillBytes?: number };
}

function unconvertiblePlaceholder(m: Message): Message {
	return {
		id: m.id,
		role: m.role,
		parts: [
			{
				type: "text",
				text: `[this message could not be prepared for the model (${m.role} role) — it is kept in history; any attachment it carried may still be readable with read_file or bash tools]`,
			},
		],
	};
}

function systemEventAsUser(m: Message): Message {
	return {
		id: m.id,
		role: "user",
		parts: [{ type: "text", text: `[system event: ${messageText(m)}]` }],
	};
}

function contextPartAsText(ctx: ViewContext, m: Message): Message {
	if (!m.parts.some((p) => p.type === CONTEXT_PART)) return m;
	return {
		...m,
		parts: m.parts.flatMap((p) => {
			if (p.type !== CONTEXT_PART) return [p];
			const parsed = contextPartDataSchema.safeParse((p as { data?: unknown }).data);
			if (parsed.success) return [{ type: "text" as const, text: contextText(parsed.data) }];
			log.warn("malformed context part — dropped from the model view", {
				conversation: ctx.convId,
				message: m.id,
			});
			return [];
		}),
	};
}

function notePartsAsText(ctx: ViewContext, m: Message): Message {
	if (!m.parts.some((p) => p.type === NOTE_PART)) return m;
	return {
		...m,
		parts: m.parts.map((p) => {
			if (p.type !== NOTE_PART) return p;
			const parsed = notePartDataSchema.safeParse((p as { data?: unknown }).data);
			if (!parsed.success) {
				log.warn("malformed note part — degrading to placeholder", {
					conversation: ctx.convId,
					message: m.id,
				});
				return {
					type: "text" as const,
					text: "[an attached note could not be rendered — its stored data was malformed]",
				};
			}
			const d = parsed.data;
			const title = d.title.replace(/"/g, "'");
			return {
				type: "text" as const,
				text: `Attached note "${title}" (id ${d.id}, rev ${d.rev} as of this message):\n${noteFence(d)}`,
			};
		}),
	};
}

function skillPartsAsText(
	ctx: ViewContext,
	m: Message,
	includeBody: boolean,
): { message: Message; invocations: SkillInvocation[] } {
	if (!m.parts.some((p) => p.type === SKILL_PART)) return { message: m, invocations: [] };
	const invocations: SkillInvocation[] = [];
	const message: Message = {
		...m,
		parts: m.parts.map((p) => {
			if (p.type !== SKILL_PART) return p;
			const parsed = skillPartDataSchema.safeParse((p as { data?: unknown }).data);
			if (!parsed.success) {
				log.warn("malformed skill part — degrading to placeholder", {
					conversation: ctx.convId,
					message: m.id,
				});
				return {
					type: "text" as const,
					text: "[a skill invocation could not be rendered — its stored data was malformed]",
				};
			}
			const resolved = ctx.skillRef(parsed.data, includeBody);
			invocations.push({ ...resolved, ref: parsed.data });
			return {
				type: "text" as const,
				text: isTempSkillRef(parsed.data)
					? tempSkillMarkerText(resolved.name, parsed.data.url)
					: skillMarkerText(resolved.name),
			};
		}),
	};
	return { message, invocations };
}

const REASONING_PART_TYPES: ReadonlySet<string> = new Set(["reasoning", "reasoning-file"]);

function dropForeignReasoning(
	ctx: ViewContext,
	m: Message,
	isPartial: boolean,
): { message: Message; dropped: number } {
	if (isPartial || m.role !== "assistant") return { message: m, dropped: 0 };
	const metadata = m.metadata as { model?: unknown } | undefined;
	if (metadata?.model === ctx.modelRef) return { message: m, dropped: 0 };
	const parts = m.parts.filter((p) => !REASONING_PART_TYPES.has(p.type));
	const dropped = m.parts.length - parts.length;
	if (dropped === 0) return { message: m, dropped: 0 };
	return { message: { ...m, parts }, dropped };
}

interface SkillInvocation {
	name: string;
	body: string | null;
	ref: SkillRef;
	source?: string;
	skillBytes?: number;
}

export function incompleteToolCallIds(m: Message): string[] {
	const ids: string[] = [];
	for (const p of m.parts) {
		if (!p.type.startsWith("tool-")) continue;
		const tool = p as { toolCallId?: unknown; state?: unknown; preliminary?: unknown };
		const kept =
			tool.state === "approval-responded" ||
			tool.state === "output-denied" ||
			tool.state === "output-error" ||
			(tool.state === "output-available" && tool.preliminary !== true);
		if (!kept) ids.push(typeof tool.toolCallId === "string" ? tool.toolCallId : p.type);
	}
	return ids;
}

export async function buildModelView(
	ctx: ViewContext,
	options: {
		entries: { seq: number; message: Message }[];
		prior: RecallContext[];
		current: RecallContext | null;
		partial: Message | null;
		summarySeq: number | null;
		ownedSeqs?: readonly number[] | ReadonlySet<number>;
		assertAuthority(): void;
	},
): Promise<PromptMessage[]> {
	const sdkTools = ctx.sdkTools ?? toToolSet(ctx.tools);
	const view = withMemoryBlocks(
		options.entries,
		options.prior,
		options.current,
		options.summarySeq,
	);
	if (options.partial !== null) view.push(options.partial);
	const owned = new Set(options.ownedSeqs ?? []);
	const seqByMessage = new Map(options.entries.map((e) => [e.message, e.seq]));
	const seqByIndex = view.map((m) => seqByMessage.get(m) ?? null);
	const prepared = await materializeAttachments(
		view.map((m) => inlineMentions(m)),
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	options.assertAuthority();
	const messages: PromptMessage[] = [];
	const partialId = options.partial?.id ?? null;
	let foreignReasoningMessages = 0;
	let foreignReasoningParts = 0;
	for (const [i, m] of prepared.entries()) {
		const entrySeq = seqByIndex[i] ?? null;
		const includeBody = entrySeq !== null && m.role === "user" && owned.has(entrySeq);
		const { message: skillMarked, invocations } = skillPartsAsText(
			ctx,
			m.role === "system" ? systemEventAsUser(m) : m,
			includeBody,
		);
		const rendered = contextPartAsText(ctx, notePartsAsText(ctx, skillMarked));
		const { message: originScoped, dropped: foreignReasoning } = dropForeignReasoning(
			ctx,
			rendered,
			options.partial !== null && i === prepared.length - 1,
		);
		if (foreignReasoning > 0) {
			foreignReasoningMessages += 1;
			foreignReasoningParts += foreignReasoning;
		}
		const unfinished = incompleteToolCallIds(originScoped);
		if (unfinished.length > 0 && m.id === partialId) {
			log.info("recovery partial ends on an unfinished tool call — dropped from the model view", {
				conversation: ctx.convId,
				message: m.id,
				toolCalls: unfinished,
			});
		} else if (unfinished.length > 0) {
			log.warn("unfinished tool call in durable history — dropped from the model view", {
				conversation: ctx.convId,
				message: m.id,
				toolCalls: unfinished,
			});
		}
		try {
			messages.push(
				...(await convertToModelMessages([originScoped], {
					tools: sdkTools,
					ignoreIncompleteToolCalls: true,
				})),
			);
		} catch (err) {
			log.warn("message unconvertible — degrading to placeholder", err, {
				conversation: ctx.convId,
				message: m.id,
				role: m.role,
			});
			messages.push(
				...(await convertToModelMessages([unconvertiblePlaceholder(originScoped)], {
					tools: sdkTools,
					ignoreIncompleteToolCalls: true,
				})),
			);
		}
		if (includeBody) {
			messages.push(...injectedBodies(ctx, invocations));
		}
	}
	if (foreignReasoningParts > 0) {
		log.info("foreign reasoning dropped from the model view", {
			conversation: ctx.convId,
			target: ctx.modelRef,
			messages: foreignReasoningMessages,
			parts: foreignReasoningParts,
		});
	}
	const scoped = ctx.keepProviderExecuted === true ? messages : dropProviderExecuted(ctx, messages);
	const merged = mergeConsecutiveUserModels(scoped);

	log.info("model request", {
		conversation: ctx.convId,
		messages: merged.length,
	});
	return merged;
}

function dropProviderExecuted(ctx: ViewContext, messages: PromptMessage[]): PromptMessage[] {
	const out: PromptMessage[] = [];
	let dropped = 0;
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) {
			out.push(m);
			continue;
		}
		const hostedIds = new Set<string>();
		for (const p of m.content) {
			const part = p as { type: string; toolCallId?: string; providerExecuted?: boolean };
			if (part.type === "tool-call" && part.providerExecuted === true && part.toolCallId) {
				hostedIds.add(part.toolCallId);
			}
		}
		const kept = m.content.filter((p) => {
			const part = p as { type: string; toolCallId?: string };
			const hosted =
				(part.type === "tool-call" || part.type === "tool-result") &&
				part.toolCallId !== undefined &&
				hostedIds.has(part.toolCallId);
			if (hosted) dropped++;
			return !hosted;
		});
		if (kept.length === m.content.length) out.push(m);
		else if (kept.length > 0) out.push({ ...m, content: kept });
	}
	if (dropped > 0) {
		log.info("provider-executed parts dropped from the model view", {
			conversation: ctx.convId,
			parts: dropped,
		});
	}
	return out;
}

function injectedBodies(ctx: ViewContext, invocations: SkillInvocation[]): PromptMessage[] {
	const bodies: PromptMessage[] = [];
	for (const inv of invocations) {
		if (inv.body === null) continue;
		log.info("skill invoked", {
			conversation: ctx.convId,
			skill: inv.name,
			source: inv.source ?? (isTempSkillRef(inv.ref) ? new URL(inv.ref.url).host : "local"),
			bytes: inv.skillBytes ?? Buffer.byteLength(inv.body, "utf8"),
		});
		bodies.push({ role: "user", content: inv.body });
	}
	return bodies;
}

export async function convertSteeredMessage(
	ctx: ViewContext,
	message: Message,
	sdkTools: ToolSet = ctx.sdkTools ?? toToolSet(ctx.tools),
): Promise<PromptMessage[]> {
	const materialized = await materializeAttachments(
		[inlineMentions(message)],
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	const out: PromptMessage[] = [];
	for (const m of materialized) {
		const { message: skillMarked, invocations } = skillPartsAsText(ctx, m, true);
		out.push(
			...(await convertToModelMessages(
				[contextPartAsText(ctx, notePartsAsText(ctx, skillMarked))],
				{
					tools: sdkTools,
					ignoreIncompleteToolCalls: true,
				},
			)),
		);
		out.push(...injectedBodies(ctx, invocations));
	}
	return out;
}

function mergeConsecutiveUserModels(messages: PromptMessage[]): PromptMessage[] {
	const out: PromptMessage[] = [];
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (m.role === "user" && prev?.role === "user") {
			const prevContent =
				typeof prev.content === "string"
					? [{ type: "text" as const, text: prev.content }]
					: prev.content;
			const content =
				typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			prev.content = [...prevContent, ...content];
		} else {
			out.push(m);
		}
	}
	return out;
}
