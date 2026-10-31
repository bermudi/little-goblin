// Read views over stored events: the causal history, the model-
// facing view cut at the compaction boundary with committed
// projections overlaid, full-text search, and context paging —
// plus the one projection write. Every reader here serves the
// stored rows; only modelEntries rewrites, and only in memory.

import type { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import {
	type Compaction,
	corruptPlaceholder,
	parseEvent,
	projectionKey,
	summaryMessage,
	toFtsQuery,
} from "./conversation-events.ts";
import type { ConversationQueries } from "./conversation-queries.ts";
import { messageText } from "./memory/mod.ts";

export interface HistoryHit {
	conversationId: string;
	title: string | null;
	seq: number;
	role: string;
	text: string;
	createdAt: string;
}

export interface HistoryContextRow {
	seq: number;
	role: string;
	// The parsed stored event — tool calls included.
	message: UIMessage;
	createdAt: string;
}

export function makeConversationHistory(
	db: Database,
	queries: Pick<
		ConversationQueries,
		| "qHistory"
		| "qHistoryCausal"
		| "qLastByRole"
		| "qProjections"
		| "qInsertProjection"
		| "qSearch"
		| "qContext"
	>,
	getCompaction: (id: string) => Compaction | null,
) {
	const {
		qHistory,
		qHistoryCausal,
		qLastByRole,
		qProjections,
		qInsertProjection,
		qSearch,
		qContext,
	} = queries;

	// The message id is the only identity the client and the store share;
	// resolve it by decoding rows (the JSON envelope is not a column the
	// wire can address). Corrupt rows decode to null and simply never
	// match.
	function findEvent(
		id: string,
		messageId: string,
	): { seq: number; role: string; anchorSeq: number | null } | null {
		for (const row of qHistory.all(id)) {
			const message = parseEvent(id, row.seq, row.role, row.data);
			if (message !== null && message.id === messageId) {
				return { seq: row.seq, role: row.role, anchorSeq: row.anchor_seq };
			}
		}
		return null;
	}

	function messageEvent(id: string, messageId: string) {
		const found = findEvent(id, messageId);
		return found === null ? null : { seq: found.seq, role: found.role };
	}

	function searchHistory(query: string, limit: number, channelPrefix?: string) {
		const match = toFtsQuery(query);
		if (match === null) return [];
		const hits: HistoryHit[] = [];
		for (const r of qSearch.all(match, channelPrefix ?? null, Math.max(1, Math.min(limit, 50)))) {
			const message = parseEvent(r.cid, r.seq, r.role, r.data);
			if (message === null) continue;
			hits.push({
				conversationId: r.cid,
				title: r.title,
				seq: r.seq,
				role: r.role,
				text: messageText(message),
				createdAt: r.created_at,
			});
		}
		return hits;
	}

	function eventContext(id: string, seq: number, window: number) {
		const w = Math.max(0, Math.min(window, 25));
		const rows: HistoryContextRow[] = [];
		for (const r of qContext.all(id, seq - w, seq + w)) {
			const message = parseEvent(id, r.seq, r.role, r.data);
			if (message === null) continue;
			rows.push({
				seq: r.seq,
				role: r.role,
				message,
				createdAt: r.created_at,
			});
		}
		return rows;
	}

	function history(id: string) {
		return historyEntries(id).map((e) => e.message);
	}

	function historyEntries(id: string) {
		return historyDetail(id).map((e) => ({ seq: e.seq, message: e.message }));
	}

	type RawRow = { seq: number; anchor_seq: number | null; role: string; data: string };

	function detailFromRows(id: string, raw: RawRow[]) {
		const rows = raw.map((r) => ({
			seq: r.seq,
			anchorSeq: r.anchor_seq,
			message: parseEvent(id, r.seq, r.role, r.data) ?? corruptPlaceholder(r.seq, r.role),
		}));
		// Arrival order stays on disk; this sorts each anchored response
		// right after its user event. Key = anchor ?? seq, tiebreak = seq
		// — an anchor always precedes its own seq.
		rows.sort((a, b) => {
			const ka = a.anchorSeq ?? a.seq;
			const kb = b.anchorSeq ?? b.seq;
			return ka - kb || a.seq - b.seq;
		});
		return rows;
	}

	function historyDetail(id: string) {
		return detailFromRows(id, qHistory.all(id));
	}

	// One-row reader for "what is the last <role> message?" callers —
	// the causal-last row, parsed alone instead of the whole history.
	function lastEntry(id: string, role: string) {
		const row = qLastByRole.get(id, role);
		if (row === null || row === undefined) return null;
		return {
			seq: row.seq,
			message: parseEvent(id, row.seq, row.role, row.data) ?? corruptPlaceholder(row.seq, row.role),
		};
	}

	function modelEntries(id: string) {
		const compaction = getCompaction(id);
		// Filter on the causal key: an anchored response to a compacted
		// user event has a high seq but an early causal position — it
		// belongs to the summarized span, not the tail. With a boundary
		// the cut is in SQL (qHistoryCausal); without one the full
		// causal view is the model view.
		const detail =
			compaction === null
				? historyDetail(id)
				: detailFromRows(id, qHistoryCausal.all(id, compaction.boundarySeq));
		const entries = detail.map((e) => ({ seq: e.seq, message: e.message }));
		// Committed pruning projections overlay the model-facing view
		// only — parseEvent returns fresh objects, so mutating them
		// here can never touch the stored row or the readers that must
		// serve originals (history, context, search).
		const projections = qProjections.all(id);
		if (projections.length > 0) {
			const byPart = new Map(
				projections.map((p) => [projectionKey(p.seq, p.tool_call_id), p.replacement] as const),
			);
			for (const entry of entries) {
				for (const part of entry.message.parts) {
					const p = part as {
						type: string;
						toolCallId?: unknown;
						state?: unknown;
						output?: unknown;
					};
					if (
						!(p.type.startsWith("tool-") || p.type === "dynamic-tool") ||
						p.state !== "output-available" ||
						typeof p.toolCallId !== "string" ||
						typeof p.output !== "string"
					)
						continue;
					const replacement = byPart.get(projectionKey(entry.seq, p.toolCallId));
					if (replacement !== undefined) p.output = replacement;
				}
			}
		}
		return compaction === null
			? entries
			: [{ seq: compaction.boundarySeq, message: summaryMessage(compaction, id) }, ...entries];
	}

	function eventProjections(id: string) {
		return qProjections
			.all(id)
			.map((p) => ({ seq: p.seq, toolCallId: p.tool_call_id, replacement: p.replacement }));
	}

	function applyEventProjections(
		id: string,
		rows: {
			seq: number;
			toolCallId: string;
			replacement: string;
			routeKey: string;
			settingsHash: string;
		}[],
	) {
		const createdAt = new Date().toISOString();
		return db.transaction(() => {
			let inserted = 0;
			for (const r of rows) {
				inserted += qInsertProjection.run(
					id,
					r.seq,
					r.toolCallId,
					r.replacement,
					r.routeKey,
					r.settingsHash,
					createdAt,
				).changes;
			}
			return inserted;
		})();
	}

	return {
		messageEvent,
		searchHistory,
		eventContext,
		history,
		historyEntries,
		historyDetail,
		lastEntry,
		modelEntries,
		eventProjections,
		applyEventProjections,
	};
}
