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
import { inlineMentions, skillMarkerText, tempSkillMarkerText } from "../inline-parts.ts";
import { messageText, type RecallContext, withMemoryBlocks } from "../memory/mod.ts";
import { CONTEXT_PART, contextPartDataSchema, contextText } from "../message-context.ts";
import { NOTE_PART, noteFence, notePartDataSchema } from "../notes.ts";
import { CHAT_NOTE_NOTICE_PART } from "../chat-note-pins.ts";
import {
	SKILL_PART,
	isTempSkillRef,
	skillPartDataSchema,
	type SkillRef,
} from "../skill-part.ts";
import {
	ADDITIONAL_TOOLS_PREFIX,
	INCREMENTAL_TOOLS_NOTICE,
	TOOLS_PART,
	foldDeclarations,
	storedToolChanges,
	toolRemovalNotice,
	type ToolChange,
	type ToolDeclaration,
} from "../agent/tool-declarations.ts";
import {
	INSERTS_PART,
	storedTurnInserts,
	type TurnInsert,
	type TurnInsertItem,
} from "../agent/turn-inserts.ts";
import { compactionSummaryId } from "../tags.ts";
import { HANDOVER_STOP_PART, isHandoverCard } from "../handover-message.ts";

export interface ViewContext {
	convId: string;
	modelRef: string;
	tools: Tools;
	sdkTools?: ToolSet;
	modalities: Set<string> | undefined;
	carries: (mediaType: string, position: MediaPosition) => boolean;
	keepProviderExecuted?: boolean;
	toolsInInput?: boolean;
	pendingToolChange?: ToolChange | null;
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
	if (!m.parts.some((p) => p.type === NOTE_PART || p.type === CHAT_NOTE_NOTICE_PART)) return m;
	return {
		...m,
		parts: m.parts.map((p) => {
			if (p.type === CHAT_NOTE_NOTICE_PART && typeof p.data === "string") {
				return { type: "text" as const, text: p.data };
			}
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
		toolHistory?: { seq: number; message: Message }[];
		prior: RecallContext[];
		current: RecallContext | null;
		partial: Message | null;
		partialInsertLimit?: number;
		summarySeq: number | null;
		ownedSeqs?: readonly number[] | ReadonlySet<number>;
		assertAuthority(): void;
	},
): Promise<PromptMessage[]> {
	const sdkTools = ctx.sdkTools ?? toToolSet(ctx.tools);
	const baseView = withMemoryBlocks(
		options.entries,
		options.prior,
		options.current,
		options.summarySeq,
	);
	if (options.partial !== null) baseView.push(options.partial);
	const storedChanges = storedToolChanges(options.toolHistory ?? options.entries, ctx.convId);
	const owned = new Set(options.ownedSeqs ?? []);
	const seqByMessage = new Map(options.entries.map((e) => [e.message, e.seq]));
	const partialStepCount =
		options.partial?.parts.filter((part) => part.type === "step-start").length ?? 0;
	const partialInsertLimit = options.partialInsertLimit ?? partialStepCount;
	const allPartialInsertRecords =
		options.partial === null
			? []
			: storedTurnInserts([{ message: options.partial }], ctx.convId);
	const partialInsertRecords = allPartialInsertRecords.flatMap(({ messageId, inserts }) => {
		const eligible = inserts.filter((insert) => insert.step < partialInsertLimit);
		return eligible.length > 0 ? [{ messageId, inserts: eligible }] : [];
	});
	const suppressedSteerSeqs = new Set(
		allPartialInsertRecords.flatMap(({ inserts }) =>
			inserts
				.filter((insert) => insert.step >= partialInsertLimit)
				.flatMap((insert) =>
					insert.items.flatMap((item) => item.kind === "steer" ? [item.seq] : []),
				),
		),
	);
	const insertRecords = [
		...storedTurnInserts(options.entries, ctx.convId),
		...partialInsertRecords,
	];
	const insertsByMessage = new Map<string, TurnInsert[]>();
	for (const { messageId, inserts } of insertRecords) {
		insertsByMessage.set(messageId, [...(insertsByMessage.get(messageId) ?? []), ...inserts]);
	}
	const replayedSeqs = new Set(insertRecords.flatMap(({ inserts }) =>
		inserts.flatMap((insert) =>
			insert.items.flatMap((item) => item.kind === "steer" ? [item.seq] : []),
		),
	));
	const isSummary = (message: Message, seq: number | null): boolean =>
		seq !== null &&
		seq === options.summarySeq &&
		message.id === compactionSummaryId(seq);
	const visibleBySeq = new Map(
		baseView.flatMap((message) => {
			const seq = seqByMessage.get(message) ?? null;
			return seq === null || isSummary(message, seq) || message.role !== "user"
				? []
				: [[seq, message] as const];
		}),
	);
	const slots: {
		message: Message;
		seq: number | null;
		replayed: boolean;
		partial?: boolean;
		directText?: string;
		dataOnly?: boolean;
	}[] = [];
	for (const message of baseView) {
		const seq = seqByMessage.get(message) ?? null;
		const isPartial = message === options.partial;
		if (
			seq !== null &&
			(replayedSeqs.has(seq) || suppressedSteerSeqs.has(seq)) &&
			!isSummary(message, seq) &&
			message.role === "user"
		)
			continue;
		if (message.role !== "assistant" || !insertsByMessage.has(message.id)) {
			slots.push({ message, seq, replayed: false, partial: isPartial });
			continue;
		}
		const inserts = insertsByMessage.get(message.id)!;
		const byPosition = new Map<number, TurnInsertItem[]>();
		for (const insert of inserts) {
			byPosition.set(insert.step, [...(byPosition.get(insert.step) ?? []), ...insert.items]);
		}
		let start = 0;
		let position = 0;
		const emitAt = (at: number): void => {
			for (const item of byPosition.get(at) ?? []) {
				if (item.kind === "text") {
					slots.push({
						message: { id: `${message.id}:insert:${at}:${slots.length}`, role: "user", parts: [{ type: "text", text: item.text }] },
						seq: null,
						replayed: true,
						directText: item.text,
					});
					continue;
				}
				const steered = visibleBySeq.get(item.seq);
				if (steered === undefined) {
					log.warn("steer insert target missing from model view", {
						conversation: ctx.convId,
						message: message.id,
						seq: item.seq,
					});
					continue;
				}
				slots.push({ message: steered, seq: item.seq, replayed: true });
			}
		};
		for (let i = 0; i < message.parts.length; i++) {
			if (message.parts[i]?.type !== "step-start") continue;
			const parts = message.parts.slice(start, i);
			const modelParts = parts.filter(
				(part) => part.type !== TOOLS_PART && part.type !== INSERTS_PART,
			);
			if (modelParts.length > 0) {
				slots.push({ message: { ...message, parts }, seq, replayed: false, partial: isPartial });
			} else if (parts.length > 0) {
				slots.push({
					message: { ...message, parts: [] },
					seq,
					replayed: false,
					partial: isPartial,
					dataOnly: true,
				});
			}
			emitAt(position++);
			start = i;
		}
		const tail = message.parts.slice(start);
		if (tail.length > 0) {
			slots.push({ message: { ...message, parts: tail }, seq, replayed: false, partial: isPartial });
		}
		emitAt(position);
	}
	const view = slots.map(({ message }) => message);
	const seqByIndex = slots.map(({ seq }) => seq);
	const prepared = await materializeAttachments(
		view.map((m) => inlineMentions(m)),
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	options.assertAuthority();
	const messages: PromptMessage[] = [];
	const unmergeable = new Set<PromptMessage>();
	const seenStoredChanges = new Set<string>();
	const isToolsInput = ctx.toolsInInput === true;
	const changesByMessage = new Map(storedChanges.map(({ messageId, change }) => [messageId, change]));
	const visibleStoredChanges = prepared.flatMap((message) => {
		const change = changesByMessage.get(message.id);
		return change === undefined ? [] : [change];
	});
	const firstVisibleChange = visibleStoredChanges[0];
	const firstVisibleIndex =
		firstVisibleChange === undefined
			? storedChanges.length
			: storedChanges.findIndex(({ change }) => change === firstVisibleChange);
	const hiddenChanges = storedChanges.slice(0, firstVisibleIndex).map(({ change }) => change);
	const headChange =
		hiddenChanges.length === 0 && firstVisibleChange !== undefined ? firstVisibleChange : undefined;
	let folded = new Map<string, ToolDeclaration>();
	const unavailable = new Set<string>();
	let pendingRenderedAtHead = false;
	if (isToolsInput) {
		const headChanges = headChange === undefined ? hiddenChanges : [headChange];
		folded = foldDeclarations(headChanges);
		for (const change of headChanges) foldUnavailable(change, unavailable);
		if (headChanges.length === 0 && ctx.pendingToolChange !== undefined && ctx.pendingToolChange !== null) {
			for (const name of ctx.pendingToolChange.removed) folded.delete(name);
			for (const declaration of ctx.pendingToolChange.added) folded.set(declaration.name, declaration);
			pendingRenderedAtHead = true;
		}
		if (folded.size > 0) messages.push(toolMarker([...folded.values()]));
	}
	const partialId = options.partial?.id ?? null;
	let foreignReasoningMessages = 0;
	let foreignReasoningParts = 0;
	for (const [i, m] of prepared.entries()) {
		const renderedStart = messages.length;
		if (slots[i]?.directText !== undefined) {
			const direct: PromptMessage = { role: "user", content: slots[i]!.directText! };
			messages.push(direct);
			unmergeable.add(direct);
			continue;
		}
		const storedChange =
			isToolsInput && !seenStoredChanges.has(m.id) ? changesByMessage.get(m.id) : undefined;
		if (storedChange !== undefined && storedChange !== headChange) {
			seenStoredChanges.add(m.id);
			messages.push(...toolChangeMessages(storedChange, folded, unavailable));
		}
		if (slots[i]?.dataOnly) continue;
		const handover = isHandoverCard(m.parts);
		if (m.role === "system" && (handover || m.parts.some((part) => part.type === HANDOVER_STOP_PART))) continue;
		const entrySeq = seqByIndex[i] ?? null;
		const includeBody = entrySeq !== null && m.role === "user" && owned.has(entrySeq);
		const { message: skillMarked, invocations } = skillPartsAsText(
			ctx,
			m.role === "system" ? systemEventAsUser(m) : m,
			includeBody,
		);
		const rendered = contextPartAsText(ctx, notePartsAsText(ctx, skillMarked));
		rendered.parts = rendered.parts.filter(
			(part) => part.type !== TOOLS_PART && part.type !== INSERTS_PART,
		);
		const { message: originScoped, dropped: foreignReasoning } = dropForeignReasoning(
			ctx,
			rendered,
			slots[i]?.partial === true,
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
		if (slots[i]?.replayed || handover) {
			for (const message of messages.slice(renderedStart)) unmergeable.add(message);
		}
	}
	if (
		isToolsInput &&
		!pendingRenderedAtHead &&
		ctx.pendingToolChange !== undefined &&
		ctx.pendingToolChange !== null
	) {
		messages.push(...toolChangeMessages(ctx.pendingToolChange, folded, unavailable));
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
	const merged = mergeConsecutiveUserModels(scoped, unmergeable);

	log.info("model request", {
		conversation: ctx.convId,
		messages: merged.length,
	});
	return merged;
}

function toolMarker(declarations: ToolDeclaration[]): PromptMessage {
	return {
		role: "system",
		content: `${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify(declarations)}`,
		providerOptions: { codex: { inInput: true } },
	};
}

function toolChangeMessages(
	change: ToolChange,
	folded: Map<string, ToolDeclaration>,
	unavailable: Set<string>,
): PromptMessage[] {
	const out: PromptMessage[] = [];
	for (const declaration of change.added) unavailable.delete(declaration.name);
	const unavailableNames = [...unavailable];
	const notice =
		unavailableNames.length > 0
			? `${INCREMENTAL_TOOLS_NOTICE}\nStill unavailable: ${unavailableNames.join(", ")}.`
			: INCREMENTAL_TOOLS_NOTICE;
	out.push({
		role: "system",
		content: notice,
		providerOptions: { codex: { inInput: true } },
	});
	if (change.added.length > 0) out.push(toolMarker(change.added));
	const added = new Set(change.added.map((declaration) => declaration.name));
	const removed = change.removed.filter((name) => !added.has(name));
	if (removed.length > 0) {
		out.push({
			role: "system",
			content: toolRemovalNotice(removed),
			providerOptions: { codex: { inInput: true } },
		});
	}
	for (const name of removed) {
		unavailable.add(name);
		folded.delete(name);
	}
	for (const name of change.removed) folded.delete(name);
	for (const declaration of change.added) folded.set(declaration.name, declaration);
	return out;
}

function foldUnavailable(change: ToolChange, unavailable: Set<string>): void {
	for (const declaration of change.added) unavailable.delete(declaration.name);
	const added = new Set(change.added.map((declaration) => declaration.name));
	for (const name of change.removed) {
		if (!added.has(name)) unavailable.add(name);
	}
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

function mergeConsecutiveUserModels(
	messages: PromptMessage[],
	unmergeable: ReadonlySet<PromptMessage> = new Set(),
): PromptMessage[] {
	const out: PromptMessage[] = [];
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (
			m.role === "user" &&
			prev?.role === "user" &&
			!unmergeable.has(m) &&
			!unmergeable.has(prev)
		) {
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
