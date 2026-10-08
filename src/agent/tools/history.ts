// The history-search tool — full-text search over goblin's own past
// conversations (DESIGN.md, Chat search). Search returns topic · date ·
// role · snippet lines with the addressing to page context around a
// hit; context returns the arrival-ordered window around one event.
// Memory-excluded topics are never searched (filtered in SQL against
// the live flag) and refuse the tool outright, the way memory_search
// does — exclusion means a topic recalls nothing.

import { tool } from "ai";
import { z } from "zod";
import type { ConversationStore } from "../../conversation.ts";
import { log } from "../../log.ts";
import { windowText } from "./fetch.ts";

export interface HistorySearchDeps {
	store: Pick<ConversationStore, "searchHistory" | "eventContext" | "get">;
	// Topic exclusion governs recall too: excluded conversations may not
	// search the shared past by any path.
	isExcluded: () => boolean;
}

// A reading window around the first query-term occurrence — the hit in
// context, not the message's head. Falls back to the head when no term
// lands (stemmed matches) or the text fits.
export function excerpt(text: string, query: string, budget = 360): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= budget) return flat;
	const lower = flat.toLowerCase();
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.replace(/"/g, ""))
		.filter((t) => t !== "");
	let at = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i !== -1 && (at === -1 || i < at)) at = i;
	}
	if (at === -1) return `${flat.slice(0, budget).trimEnd()}…`;
	const start = Math.max(0, at - Math.floor(budget / 3));
	const end = Math.min(flat.length, start + budget);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

function hitLine(
	i: number,
	h: {
		conversationId: string;
		title: string | null;
		seq: number;
		role: string;
		text: string;
		createdAt: string;
	},
	query: string,
): string {
	const head = `${i + 1}. ${h.title ?? "(untitled)"} (${h.conversationId}) · ${h.role} · ${h.createdAt.slice(0, 10)} · seq ${h.seq}`;
	return `${head}\n   ${excerpt(h.text, query)}`;
}

const searchSchema = z.object({
	action: z.literal("search"),
	query: z.string().min(1).max(400),
	limit: z.number().int().min(1).max(20).optional(),
});
const contextSchema = z.object({
	action: z.literal("context"),
	conversation: z.string().min(1).max(200),
	seq: z.number().int().min(1),
	window: z.number().int().min(0).max(10).optional(),
});
// The strict per-action contract, enforced inside execute.
const actionSchema = z.discriminatedUnion("action", [searchSchema, contextSchema]);

// Tool providers expect an object at the root. A discriminated union
// serializes to root-level oneOf, which some providers cannot use to
// generate arguments — every call then arrives as `{}` and fails
// validation (took down mail on Sep 28, then program the same way).
// Keep the wire schema flat; actionSchema still owns the exact
// per-action contract.
export const historyInputSchema = z
	.object({
		action: z.enum(["search", "context"]),
		query: searchSchema.shape.query.optional(),
		limit: searchSchema.shape.limit,
		conversation: contextSchema.shape.conversation.optional(),
		seq: contextSchema.shape.seq.optional(),
		window: contextSchema.shape.window,
	})
	.superRefine((value, ctx) => {
		const result = actionSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	});

export const historySearchTool = (deps: HistorySearchDeps) =>
	tool({
		description:
			'Search goblin\'s own past conversations across every topic ("what did we decide about X?"). ' +
			"Search returns topic · role · date · snippet lines, each with its conversation id and event seq — " +
			"page context around a hit with the context action. Topics excluded from memory are never searched.",
		inputSchema: historyInputSchema,
		execute: async (raw) => {
			if (deps.isExcluded()) {
				return { error: "memory is excluded in this conversation" };
			}
			const input = actionSchema.parse(raw);
			switch (input.action) {
				case "search": {
					const started = Date.now();
					const hits = deps.store.searchHistory(input.query, input.limit ?? 8);
					log.info("history searched", {
						query: input.query,
						results: hits.length,
						ms: Date.now() - started,
					});
					if (hits.length === 0) return "No past conversations match.";
					const lines = hits.map((h, i) => hitLine(i, h, input.query)).join("\n");
					return `${lines}\n\nPage context around a hit with action="context", its conversation id, and its seq.`;
				}
				case "context": {
					const conv = deps.store.get(input.conversation);
					if (!conv) return { error: `no conversation "${input.conversation}"` };
					if (conv.memoryExcluded) {
						return { error: "that conversation is excluded from memory" };
					}
					const rows = deps.store.eventContext(input.conversation, input.seq, input.window ?? 3);
					log.info("history context", {
						conversation: input.conversation,
						seq: input.seq,
						window: input.window ?? 3,
						messages: rows.length,
					});
					if (rows.length === 0) {
						return `No messages at conversation "${input.conversation}" near seq ${input.seq}.`;
					}
					const first = rows[0]!.seq;
					const last = rows[rows.length - 1]!.seq;
					const header = `[${conv.title ?? "(untitled)"}] (${conv.id}) — seq ${first}–${last}`;
					const body = rows.map((r) => {
						const text = r.text === "" ? "[(no text content)]" : windowText(r.text, 2000).window;
						return `#${r.seq} · ${r.role} · ${r.createdAt.slice(0, 10)}:\n${text}`;
					});
					return [header, ...body].join("\n\n");
				}
			}
		},
	});
