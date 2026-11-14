// The conversation store's prepared statements, prepared once at
// open. Pure preparation — every statement's SQL and parameter
// shape lives here; the store owns what they mean.

import type { Database } from "bun:sqlite";

export interface Row {
	id: string;
	chat_id: number;
	thread_id: number | null;
	title: string | null;
	title_implicit: number;
	cwd: string; // kept: column exists in existing DBs; never read into Conversation
	model: string | null;
	thinking: string | null;
	voice: number;
	memory_excluded: number;
	// Set only when a project's memory gate stamped memory_excluded — an
	// operator's own exclusion carries 0 and survives the gate re-opening.
	memory_excluded_by_project: number;
	// "guest" = the sandbox persona: no private files in, nothing about
	// the operator out. Frozen at creation.
	persona: string;
	epoch: number;
	created_at: string;
	previous_dm_id: string | null; // internal navigation link, never on the wire
	archived_at: string | null;
	pinned_at: string | null;
	project_id: string | null;
}

// The causal key the events_causal index is keyed on (the DDL lives in
// conversation-schema.ts). SQLite serves an expression from an expression
// index only when the text matches, so the DDL and every statement below
// must share this constant — drift silently degrades to full scan + sort.
export const CAUSAL_KEY_SQL = "COALESCE(anchor_seq, seq)";

// The model view's bounded twin: the compaction cut lives in SQL,
// so pre-boundary rows (data blobs included) are never read/parsed.
// Ordered by the causal key so events_causal serves the scan with no
// temp sort; detailFromRows re-sorts to the same order anyway.
export const HISTORY_CAUSAL_SQL = `SELECT seq, anchor_seq, role, data, created_at FROM events WHERE conversation_id = ? AND ${CAUSAL_KEY_SQL} > ? ORDER BY ${CAUSAL_KEY_SQL}, seq`;
// Causal-last event of one role — ORDER BY the causal key, not seq:
// a late answer (high seq, early anchor) is causally earlier.
export const LAST_BY_ROLE_SQL = `SELECT seq, anchor_seq, role, data FROM events WHERE conversation_id = ? AND role = ? ORDER BY ${CAUSAL_KEY_SQL} DESC, seq DESC LIMIT 1`;
// A branch's copy source: the causal prefix, cut exactly where the
// compaction cut reads — a late answer to an earlier question rides
// with its question, never past the branch point. Ordered by seq (the
// copy lands as-is), so the causal index serves the lookup, not the sort.
export const EVENTS_THROUGH_SQL = `SELECT seq, role, data, anchor_seq, created_at, memory_eligible FROM events
				 WHERE conversation_id = ? AND ${CAUSAL_KEY_SQL} <= ? ORDER BY seq`;
// A branch's projection copy rides the copied event set, not the raw
// seq: a late answer that rides with its question takes its overlay
// along — without it the branch's model view would serve the full
// output where the source serves the replacement.
export const PROJECTIONS_THROUGH_SQL = `SELECT seq, tool_call_id, replacement, route_key, settings_hash, created_at
				 FROM event_projections WHERE conversation_id = ?1
				 AND seq IN (SELECT seq FROM events WHERE conversation_id = ?1
				  AND ${CAUSAL_KEY_SQL} <= ?2) ORDER BY seq`;
// An edit's causal cut: the events the cut drops, and the projections
// keyed on that same event set — the sweep order lives with the queries.
export const REWIND_EVENTS_SQL = `DELETE FROM events WHERE conversation_id = ?1
				 AND ${CAUSAL_KEY_SQL} >= ?2`;
export const REWIND_PROJECTIONS_SQL = `DELETE FROM event_projections WHERE conversation_id = ?1
				 AND seq IN (SELECT seq FROM events WHERE conversation_id = ?1
				  AND ${CAUSAL_KEY_SQL} >= ?2)`;

export function prepareConversationQueries(db: Database) {
	const qCompaction = db.query<
		{
			boundary_seq: number;
			summary: string;
			summary_eligible: number;
			tokens_before: number;
			model: string;
			created_at: string;
			tail_events: number | null;
		},
		[string]
	>(
		"SELECT boundary_seq, summary, summary_eligible, tokens_before, model, created_at, tail_events FROM compactions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
	);
	// Every pointer, oldest first — the transcript's fold marks.
	const qCompactions = db.query<
		{
			boundary_seq: number;
			summary: string;
			tokens_before: number;
			tail_events: number | null;
			model: string;
			created_at: string;
		},
		[string]
	>(
		"SELECT boundary_seq, summary, tokens_before, tail_events, model, created_at FROM compactions WHERE conversation_id = ? ORDER BY id",
	);
	const qInsertCompaction = db.query(
		"INSERT INTO compactions (conversation_id, boundary_seq, summary, summary_eligible, tokens_before, model, created_at, tail_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const qGet = db.query<Row, [string]>("SELECT * FROM conversations WHERE id = ?");
	const qInsertConv = db.query(
		`INSERT INTO conversations (id, chat_id, thread_id, title, cwd, created_at, epoch)
			 VALUES (?, ?, ?, NULL, ?, ?,
				COALESCE((SELECT epoch + 1 FROM conversation_epoch_hwm WHERE conversation_id = ?1), 0))`,
	);
	const qDmRoll = db.query<{ current_id: string; n: number; selected_at: string | null }, [number]>(
		"SELECT current_id, n, selected_at FROM dm_rolls WHERE chat_id = ?",
	);
	// rollDm's pointer-less recovery: every candidate id that could carry
	// a rolling ordinal for this chat — extant private rows plus the
	// delete tombstones (a deleted dm:<chat>:<n> must never re-mint: its
	// epoch tokens may still be outstanding). A plain id list fed through
	// rollingDmOrdinal is enough — malformed, legacy and foreign-chat ids
	// all decode to null there.
	const qDmOrdinalCandidates = db.query<{ id: string }, [number, string]>(
		`SELECT id FROM conversations WHERE chat_id = ? AND thread_id IS NULL
			 UNION
			 SELECT conversation_id AS id FROM conversation_epoch_hwm
			 WHERE conversation_id LIKE 'dm:' || ? || ':%'`,
	);
	const qDmRollHighwater = db.query<{ n: number }, [number]>(
		"SELECT n FROM dm_roll_highwater WHERE chat_id = ?",
	);
	const qUpsertRoll = db.query(
		`INSERT INTO dm_rolls (chat_id, current_id, n, selected_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET current_id = excluded.current_id,
			 n = excluded.n, selected_at = excluded.selected_at`,
	);
	const qSelectPrevious = db.query(
		"UPDATE dm_rolls SET current_id = ?, selected_at = ? WHERE chat_id = ?",
	);
	const qLastActivity = db.query<{ created_at: string }, [string]>(
		"SELECT created_at FROM events WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
	);
	const qHistory = db.query<
		{ seq: number; anchor_seq: number | null; role: string; data: string; created_at: string },
		[string]
	>(
		"SELECT seq, anchor_seq, role, data, created_at FROM events WHERE conversation_id = ? ORDER BY seq",
	);
	const qHistoryCausal = db.query<
		{ seq: number; anchor_seq: number | null; role: string; data: string; created_at: string },
		[string, number]
	>(HISTORY_CAUSAL_SQL);
	// The transcript's skeleton without message payloads: windowing,
	// fold-mark positions and rateable-winner detection all read this —
	// the app's paged history must never parse data for unserved rows.
	const qHistorySlim = db.query<
		{ seq: number; anchor_seq: number | null; role: string; created_at: string },
		[string]
	>("SELECT seq, anchor_seq, role, created_at FROM events WHERE conversation_id = ? ORDER BY seq");
	// Full rows for one served window; the seq list rides a json_each
	// parameter so one prepared statement serves every window size.
	const qHistoryData = db.query<
		{ seq: number; anchor_seq: number | null; role: string; data: string; created_at: string },
		[string, string]
	>(
		"SELECT seq, anchor_seq, role, data, created_at FROM events WHERE conversation_id = ? AND seq IN (SELECT value FROM json_each(?))",
	);
	// Message ids for a seq set — the rating seam joins durable seqs to
	// the envelope's message.id without parsing every row. Corrupt rows
	// surface NULL; the caller names them like corruptPlaceholder does.
	const qMessageIds = db.query<{ seq: number; mid: string | null }, [string, string]>(
		"SELECT seq, json_extract(data, '$.message.id') AS mid FROM events WHERE conversation_id = ? AND seq IN (SELECT value FROM json_each(?))",
	);
	const qLastByRole = db.query<
		{ seq: number; anchor_seq: number | null; role: string; data: string },
		[string, string]
	>(LAST_BY_ROLE_SQL);
	const qLastEventSeq = db.query<{ seq: number | null }, [string]>(
		"SELECT MAX(seq) AS seq FROM events WHERE conversation_id = ?",
	);
	const qLastUserSeq = db.query<{ seq: number }, [string]>(
		"SELECT seq FROM events WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1",
	);
	const qLastReplyAnchor = db.query<{ anchor_seq: number | null }, [string]>(
		"SELECT anchor_seq FROM events WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
	);
	const qNextSeq = db.query<{ n: number }, [string]>(
		`SELECT MAX(
				COALESCE((SELECT MAX(seq) FROM events WHERE conversation_id = ?1), 0),
				COALESCE((SELECT seq_highwater FROM conversations WHERE id = ?1), 0)
			) AS n`,
	);
	// Memory-bound filter inputs: eligible seqs + folded-span ineligible
	// count.
	const qEligibleSeqs = db.query<{ seq: number }, [string]>(
		"SELECT seq FROM events WHERE conversation_id = ? AND memory_eligible = 1",
	);
	const qIneligibleFolded = db.query<{ n: number }, [string, number]>(
		`SELECT COUNT(*) AS n FROM events
			WHERE conversation_id = ?1
			  AND memory_eligible = 0
			  AND ((anchor_seq IS NOT NULL AND anchor_seq <= ?2)
			    OR (anchor_seq IS NULL AND seq <= ?2))`,
	);
	const qInsertEvent = db.query(
		"INSERT INTO events (conversation_id, seq, role, data, anchor_seq, created_at, memory_eligible) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	// forkToApp's copy source — verbatim, created_at and the eligibility
	// stamp included (unlike the history view).
	const qAllEvents = db.query<
		{
			seq: number;
			role: string;
			data: string;
			anchor_seq: number | null;
			created_at: string;
			memory_eligible: number;
		},
		[string]
	>(
		"SELECT seq, role, data, anchor_seq, created_at, memory_eligible FROM events WHERE conversation_id = ? ORDER BY seq",
	);
	const qEventsThrough = db.query<
		{
			seq: number;
			role: string;
			data: string;
			anchor_seq: number | null;
			created_at: string;
			memory_eligible: number;
		},
		[string, number]
	>(EVENTS_THROUGH_SQL);
	const qContextsFor = db.query<
		{ anchor_seq: number; content: string; source_ids: string; created_at: string },
		[string]
	>(
		"SELECT anchor_seq, content, source_ids, created_at FROM memory_contexts WHERE conversation_id = ? ORDER BY anchor_seq",
	);
	const qInsertContext = db.query(
		"INSERT INTO memory_contexts (conversation_id, anchor_seq, content, source_ids, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	// A branch keeps the recall slices that still describe its own prefix.
	const qContextsThrough = db.query<
		{ anchor_seq: number; content: string; source_ids: string; created_at: string },
		[string, number]
	>(
		"SELECT anchor_seq, content, source_ids, created_at FROM memory_contexts WHERE conversation_id = ? AND anchor_seq <= ? ORDER BY anchor_seq",
	);
	// The overlay read and the fork's verbatim copy source.
	const qProjections = db.query<
		{ seq: number; tool_call_id: string; replacement: string },
		[string]
	>(
		"SELECT seq, tool_call_id, replacement FROM event_projections WHERE conversation_id = ? ORDER BY seq",
	);
	const qAllProjections = db.query<
		{
			seq: number;
			tool_call_id: string;
			replacement: string;
			route_key: string;
			settings_hash: string;
			created_at: string;
		},
		[string]
	>(
		"SELECT seq, tool_call_id, replacement, route_key, settings_hash, created_at FROM event_projections WHERE conversation_id = ? ORDER BY seq",
	);
	const qInsertProjection = db.query(
		"INSERT OR IGNORE INTO event_projections (conversation_id, seq, tool_call_id, replacement, route_key, settings_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const qProjectionsThrough = db.query<
		{
			seq: number;
			tool_call_id: string;
			replacement: string;
			route_key: string;
			settings_hash: string;
			created_at: string;
		},
		[string, number]
	>(PROJECTIONS_THROUGH_SQL);
	const qEpoch = db.query<{ epoch: number }, [string]>(
		"SELECT epoch FROM conversations WHERE id = ?",
	);
	// FTS rowids join to events for the hit and conversations for the
	// title + live exclusion flag; FTS5's default rank is best-first.
	const qSearch = db.query<
		{
			cid: string;
			seq: number;
			role: string;
			data: string;
			created_at: string;
			title: string | null;
		},
		[string, string | null, number]
	>(
		`SELECT e.conversation_id AS cid, e.seq AS seq, e.role AS role,
				e.data AS data, e.created_at AS created_at, c.title AS title
			FROM events_fts
			JOIN events e ON events_fts.rowid = e.id
			JOIN conversations c ON c.id = e.conversation_id
			WHERE events_fts MATCH ?1 AND c.memory_excluded = 0
			  AND (?2 IS NULL OR e.conversation_id LIKE ?2)
			ORDER BY rank LIMIT ?3`,
	);
	const qContext = db.query<
		{ seq: number; role: string; data: string; created_at: string },
		[string, number, number]
	>(
		`SELECT seq, role, data, created_at FROM events
			WHERE conversation_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
	);
	const qListApp = db.query<
		{
			id: string;
			title: string | null;
			created_at: string;
			archived_at: string | null;
			pinned_at: string | null;
			project_id: string | null;
		},
		[]
	>(
		`SELECT id, title, created_at, archived_at, pinned_at, project_id FROM conversations
			WHERE id LIKE 'app/%' ORDER BY created_at, rowid`,
	);
	const qProjectConvs = db.query<{ id: string }, [string]>(
		"SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at, rowid",
	);
	// Freshness and preview source; the rowid rides along as activity
	// order — created_at ties within a millisecond can't order two writes.
	const qLastAppEvent = db.query<
		{ id: number; seq: number; role: string; data: string; created_at: string },
		[string]
	>(
		`SELECT id, seq, role, data, created_at FROM events
			WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1`,
	);
	// deleteConversation's sweep — children before the row (the FK
	// demands it); the events delete fires the FTS trigger per row.
	const qDeleteEvents = db.query("DELETE FROM events WHERE conversation_id = ?");
	const qDeleteCompactions = db.query("DELETE FROM compactions WHERE conversation_id = ?");
	const qDeleteContexts = db.query("DELETE FROM memory_contexts WHERE conversation_id = ?");
	const qDeleteWindows = db.query("DELETE FROM context_windows WHERE conversation_id = ?");
	// #418: a rewind or delete retires every native session record — the
	// SDK transcript still holds the retracted content, so the record
	// can never honestly resume.
	const qDeleteClaudeSessions = db.query("DELETE FROM claude_sessions WHERE conversation_id = ?");
	const qDeleteConv = db.query("DELETE FROM conversations WHERE id = ?");
	// An edit's targeted deletes, all keyed by the same causal cut. Each
	// dependent was derived from the events the cut drops, so keeping it
	// would let the model (or the rail) read a transcript that no longer
	// exists. Projections and ratings key on the causal event set itself:
	// a late answer that rides with its question keeps its projection (the
	// overlay follows the event it rewrites) and its rating — so the
	// projection delete reads events and must run before the event delete.
	const qRewindEvents = db.query(REWIND_EVENTS_SQL);
	const qRewindCompactions = db.query(
		"DELETE FROM compactions WHERE conversation_id = ? AND boundary_seq >= ?",
	);
	const qRewindContexts = db.query(
		"DELETE FROM memory_contexts WHERE conversation_id = ? AND anchor_seq >= ?",
	);
	const qRewindProjections = db.query(REWIND_PROJECTIONS_SQL);
	// A rating row denormalizes its event's seq and anchor, so the causal
	// key evaluated on the row is the rated event's fate; a legacy null
	// event_seq falls back to the anchor, as before.
	const qRewindRatings = db.query(
		`DELETE FROM reply_ratings WHERE channel = 'app' AND conversation_id = ?1
			 AND COALESCE(anchor_seq, event_seq) >= ?2`,
	);
	const qRaiseSeqHighwater = db.query(
		`UPDATE conversations SET seq_highwater = MAX(seq_highwater,
				COALESCE((SELECT MAX(seq) FROM events WHERE conversation_id = ?1), 0))
			 WHERE id = ?1`,
	);

	return {
		qCompaction,
		qCompactions,
		qInsertCompaction,
		qGet,
		qInsertConv,
		qDmRoll,
		qDmOrdinalCandidates,
		qDmRollHighwater,
		qUpsertRoll,
		qSelectPrevious,
		qLastActivity,
		qHistory,
		qHistoryCausal,
		qHistorySlim,
		qHistoryData,
		qMessageIds,
		qLastByRole,
		qLastEventSeq,
		qLastUserSeq,
		qLastReplyAnchor,
		qNextSeq,
		qEligibleSeqs,
		qIneligibleFolded,
		qInsertEvent,
		qAllEvents,
		qEventsThrough,
		qContextsFor,
		qInsertContext,
		qContextsThrough,
		qProjections,
		qAllProjections,
		qInsertProjection,
		qProjectionsThrough,
		qEpoch,
		qSearch,
		qContext,
		qListApp,
		qProjectConvs,
		qLastAppEvent,
		qDeleteEvents,
		qDeleteCompactions,
		qDeleteContexts,
		qDeleteWindows,
		qDeleteClaudeSessions,
		qDeleteConv,
		qRewindEvents,
		qRewindCompactions,
		qRewindContexts,
		qRewindProjections,
		qRewindRatings,
		qRaiseSeqHighwater,
	};
}

export type ConversationQueries = ReturnType<typeof prepareConversationQueries>;
