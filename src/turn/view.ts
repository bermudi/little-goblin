import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import {
	INLINE_ITEM_MAX_BYTES,
	type MediaPosition,
	materializeAttachments,
} from "../agent/attachments.ts";
import { log } from "../log.ts";
import { messageText, type RecallContext, withMemoryBlocks } from "../memory/mod.ts";
import { NOTE_PART, noteFence, notePartDataSchema } from "../notes.ts";

export interface ViewContext {
	convId: string;
	tools: ToolSet;
	modalities: Set<string> | undefined;
	carries: (mediaType: string, position: MediaPosition) => boolean;
}

function unconvertiblePlaceholder(m: UIMessage): UIMessage {
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

function systemEventAsUser(m: UIMessage): UIMessage {
	return {
		id: m.id,
		role: "user",
		parts: [{ type: "text", text: `[system event: ${messageText(m)}]` }],
	};
}

function notePartsAsText(ctx: ViewContext, m: UIMessage): UIMessage {
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

// Mirrors convertToModelMessages' ignoreIncompleteToolCalls keep-set — if the SDK's set changes, this must follow or the drop log drifts.
export function incompleteToolCallIds(m: UIMessage): string[] {
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
		entries: { seq: number; message: UIMessage }[];
		prior: RecallContext[];
		current: RecallContext | null;
		partial: UIMessage | null;
		assertAuthority(): void;
	},
): Promise<ModelMessage[]> {
	const view = withMemoryBlocks(options.entries, options.prior, options.current);
	if (options.partial !== null) view.push(options.partial);
	const prepared = await materializeAttachments(
		view,
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	options.assertAuthority();
	const messages: ModelMessage[] = [];
	const partialId = options.partial?.id ?? null;
	for (const m of prepared) {
		const rendered = notePartsAsText(ctx, m.role === "system" ? systemEventAsUser(m) : m);
		const unfinished = incompleteToolCallIds(rendered);
		if (unfinished.length > 0 && m.id === partialId) {
			log.info("resume partial ends on an unfinished tool call — dropped from the model view", {
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
				...(await convertToModelMessages([rendered], {
					tools: ctx.tools,
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
				...(await convertToModelMessages([unconvertiblePlaceholder(rendered)], {
					tools: ctx.tools,
					ignoreIncompleteToolCalls: true,
				})),
			);
		}
	}
	const merged = mergeConsecutiveUserModels(messages);

	log.info("model request", {
		conversation: ctx.convId,
		messages: merged.length,
	});
	return merged;
}

export async function convertSteeredMessage(
	ctx: ViewContext,
	message: UIMessage,
): Promise<ModelMessage[]> {
	const materialized = await materializeAttachments(
		[message],
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	return convertToModelMessages(
		materialized.map((m) => notePartsAsText(ctx, m)),
		{
			tools: ctx.tools,
			ignoreIncompleteToolCalls: true,
		},
	);
}

function mergeConsecutiveUserModels(messages: ModelMessage[]): ModelMessage[] {
	const out: ModelMessage[] = [];
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
