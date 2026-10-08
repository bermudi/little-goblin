// View — the turn's model view (design/runtime-turn.md → phase 3, the
// cache-stability surface). Pure prompt assembly: the admission
// snapshot's owned entries, the recall result, and a resume's partial
// reply become the byte-stable ModelMessage[] the provider sees. No
// clock, no store reads, no mutation — determinism here is what keeps
// turn N+1's request equal to turn N's plus appended content (DESIGN.md
// → Cache stability). The entries arrive already owned (#82 lives in
// admission); the one runtime contact is the injected authority
// re-check around the awaits, per the extraction rule.

import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import {
	INLINE_ITEM_MAX_BYTES,
	materializeAttachments,
	type MediaPosition,
} from "../agent/attachments.ts";
import { log } from "../log.ts";
import { messageText, withMemoryBlocks, type RecallContext } from "../memory.ts";

// The conversion context, fixed for the attempt: this turn's fenced
// ToolSet plus the ModelStep's capability gates. Built once by the
// runtime after buildStep resolves; the steer fold converts through the
// same gates so a steered message materializes exactly as it would have
// in the next turn's view.
export interface ViewContext {
	convId: string;
	tools: ToolSet;
	// The step's input modalities — undefined means text-only and every
	// stored attachment part degrades to its path reference.
	modalities: Set<string> | undefined;
	// The provider pipe's media gate (carries, providers.ts).
	carries: (mediaType: string, position: MediaPosition) => boolean;
}

// A message that cannot convert to the wire format degrades to a
// readable placeholder in position — role and id preserved — instead of
// failing every future turn identically. The corrupt-row precedent lives
// at the store boundary (conversation.ts, corruptPlaceholder); this is
// the same degradation one step later, at the conversion boundary. The
// original message stays in history: arrival-order storage is the truth.
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

// A history system event (the reviewer's save note — design/skills.md)
// cannot reach the model as a system message: streamText rejects system
// roles in `messages`, and `instructions` is the frozen per-conversation
// prefix — per-event text can't join it without breaking the prompt
// cache. Rendered instead as a bracketed user-role note in position,
// the same way memory recall blocks ride the wire (memory.ts,
// withMemoryBlocks). Deterministic: identical history bytes turn to
// turn. The stored role stays "system" — this mapping is render-only.
function systemEventAsUser(m: UIMessage): UIMessage {
	return {
		id: m.id,
		role: "user",
		parts: [{ type: "text", text: `[system event: ${messageText(m)}]` }],
	};
}

// The full view: interleave recall blocks before their anchored user
// messages, append a resume's partial reply, materialize attachment refs
// against this turn's model, convert per message (degrading the
// unconvertible alone), then merge consecutive user messages.
export async function buildModelView(
	ctx: ViewContext,
	options: {
		// The admission snapshot's owned entries, oldest first — already
		// filtered by ownership; a queued-but-unowned submit never reaches
		// here.
		entries: { seq: number; message: UIMessage }[];
		prior: RecallContext[];
		current: RecallContext | null;
		// A resume's in-progress assistant message — this turn's partial
		// reply, continued as the same message so tools never re-run.
		partial: UIMessage | null;
		// The authority re-check between the materialize await and the
		// conversion loop — the one point the fence guards inside view
		// work (the doc's injected-check arrangement).
		assertAuthority(): void;
	},
): Promise<ModelMessage[]> {
	// Memory recall blocks interleave before their anchored user
	// message (persisted, never regenerated); without memory the
	// sequence is byte-identical to history.
	const view = withMemoryBlocks(options.entries, options.prior, options.current);
	// A resume's partial reply goes last: it is this turn's
	// in-progress assistant message, and its tool results get the
	// same media treatment as any history event.
	if (options.partial !== null) view.push(options.partial);
	const prepared = await materializeAttachments(
		view,
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	options.assertAuthority();
	// Convert per message: one malformed message must not fail the
	// turn. History is durable — a whole-array conversion failure
	// would repeat identically on every future turn and brick the
	// conversation (a failed steer leaves exactly such a message
	// behind). Per-message conversion is output-identical: the
	// converter is a pure per-message mapper (its only cross-message
	// step, the incomplete-tool-call filter, is itself per-message).
	const messages: ModelMessage[] = [];
	for (const m of prepared) {
		// System events render as user-role notes — the SDK rejects
		// system roles in `messages` (see systemEventAsUser). The
		// placeholder fallback sees the mapped message, so a doubly
		// broken event degrades to a user-role note too.
		const rendered = m.role === "system" ? systemEventAsUser(m) : m;
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
	// Merge after conversion: one malformed message must degrade ALONE
	// — a UIMessage-level merge would fuse it with its burst-mates and
	// the placeholder would swallow their text.
	const merged = mergeConsecutiveUserModels(messages);

	// Cache observability (DESIGN.md, Cache stability): the per-call
	// request hashes — head (system + tools) and full request — are
	// logged by the model wrapper at EVERY call: tool-loop
	// continuations, retries, titling. See observedModel in
	// agent/providers.ts; this line only anchors the turn.
	log.info("model request", {
		conversation: ctx.convId,
		messages: merged.length,
	});
	return merged;
}

// The single-message variant the steering fold uses: one submit
// materializes and converts against the attempt's context. No
// degradation fallback here — a message this path cannot carry is the
// caller's poison-pill case (error that submit, keep the turn
// answerable); the full builder above degrades it to a placeholder in
// later views. The caller owns the epoch verdicts around the awaits.
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
	return convertToModelMessages(materialized, {
		tools: ctx.tools,
		ignoreIncompleteToolCalls: true,
	});
}

// A burst of user input with no answer between the messages is one
// conversational beat — merge adjacent user messages so the model reads
// them as a single message, not N. Runs on the CONVERTED messages: the
// conversion must stay per-message (one malformed message degrades
// alone — a merge before conversion would let its placeholder swallow
// burst-mates' text), and the wire bytes are identical either way for
// valid input.
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
