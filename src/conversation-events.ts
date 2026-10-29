// Stored-event decoding and the text projections history readers
// share. Disk rows are versioned envelopes; a row that is not an
// envelope degrades to a placeholder, never a throw — one malformed
// row must not kill every future turn.

import type { UIMessage } from "ai";
import { z } from "zod";
import { log } from "./log.ts";
import { compactionSummaryId, corruptRowId } from "./tags.ts";

// (seq, toolCallId) encoded without concat ambiguity — (2, "34") and
// (23, "4") must stay distinct; a plain concat would cross-replace.
export function projectionKey(seq: number, toolCallId: string): string {
	return JSON.stringify([seq, toolCallId]);
}

// Rows append forever; the latest per conversation is the active boundary.
// summaryEligible is store-stamped, never caller input — derived text may
// reach memory-bound builders only when every folded event was eligible.
export interface Compaction {
	boundarySeq: number;
	summary: string;
	summaryEligible: boolean;
	tokensBefore: number;
	model: string;
	createdAt: string;
}

// What a caller writes — summaryEligible is store-computed, never input.
export type CompactionWrite = Omit<Compaction, "summaryEligible">;

// Disk state is a boundary: validated on read, loosely (the runtime's
// converters own per-part semantics). A row that isn't an envelope degrades
// to a placeholder, never a throw — one malformed row must not kill every
// future turn.
const uiMessageSchema = z.looseObject({
	id: z.string(),
	role: z.enum(["system", "user", "assistant"]),
	parts: z.array(z.looseObject({ type: z.string() })),
});

const roleSchema = z.enum(["system", "user", "assistant"]);

// The placeholder keeps the row's position (seq/anchor preserved) — a
// note where a message was, not a parse error.
export function corruptPlaceholder(seq: number, role: string): UIMessage {
	const parsed = roleSchema.safeParse(role);
	return {
		id: corruptRowId(seq),
		role: parsed.success ? parsed.data : "user",
		parts: [
			{
				type: "text",
				text: `[unreadable history row seq ${seq} — stored message failed validation. Any attachment it carried may still be readable with read_file or bash tools.]`,
			},
		],
	};
}

// Rows are versioned envelopes {"v":1,"message":…} — the SDK owns part
// shapes, so each row stamps the format that wrote it. Reads are
// envelope-only; straggler bare rows wrap once at open.
function envelopeOf(raw: unknown): unknown {
	if (
		typeof raw === "object" &&
		raw !== null &&
		"v" in raw &&
		(raw as { v?: unknown }).v === 1 &&
		"message" in raw
	) {
		return (raw as { message: unknown }).message;
	}
	return null;
}

// The compacted view's synthetic first message: user role but framed as
// carried context, not a forged transcript. seq = the boundary, so causal
// sorting keeps it first. The marker names the recovery path — this
// conversation's id and the boundary seq, pageable with history_search.
// Read-time minting must be deterministic per conversation — byte-stable
// across turns for prefix-cache stability.
export function summaryMessage(compaction: Compaction, conversationId: string): UIMessage {
	return {
		id: compactionSummaryId(compaction.boundarySeq),
		role: "user",
		parts: [
			{
				type: "text",
				text: `[history compacted — conversation ${conversationId}: the summary below replaces everything before seq ${compaction.boundarySeq}; treat it as accurate carried context, not as a message anyone sent. The full record is kept: history_search action="context" with this conversation id and a seq below ${compaction.boundarySeq} pages it, tool calls and results included, when that tool is in your set]\n\n${compaction.summary}`,
			},
		],
	};
}

// Each term a double-quoted phrase so no FTS5 query syntax reaches MATCH.
// Null = no searchable terms.
export function toFtsQuery(query: string): string | null {
	const terms = query
		.split(/\s+/)
		.map((t) => t.replace(/"/g, "").trim())
		.filter((t) => t !== "");
	if (terms.length === 0) return null;
	return terms.map((t) => `"${t}"`).join(" ");
}

// Single-line labels for list titles/previews — markdown furniture comes
// off, or a reply that opens on a code block titles the row
// "```typescript const slug = …".
export function flatLine(text: string): string {
	return text
		.replace(/```+[ \t]*[^\s`\n]*/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(\*|_)([^\s*_][^*_]*?[^\s*]|[^\s*_])\1/g, "$2")
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

// Null when unreadable — history degrades to a placeholder, search and
// context skip. Warns either way: a silent skip would hide corruption.
export function parseEvent(
	conversation: string,
	seq: number,
	role: string,
	data: string,
): UIMessage | null {
	let raw: unknown;
	try {
		raw = JSON.parse(data);
	} catch (err) {
		log.warn("corrupt history row — degrading to placeholder", err, {
			conversation,
			seq,
		});
		return null;
	}
	const parsed = uiMessageSchema.safeParse(envelopeOf(raw));
	if (!parsed.success) {
		log.warn("corrupt history row — degrading to placeholder", parsed.error, {
			conversation,
			seq,
		});
		return null;
	}
	return parsed.data as UIMessage;
}
