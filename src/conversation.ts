// Conversation store — SQLite (bun:sqlite, WAL). A conversation is keyed by
// its channel address: a Telegram DM or forum topic, or a client-minted app
// id (DESIGN.md, App channel — two disjoint pools, one store). Owns meta
// (model/thinking overrides, epoch) and the durable event history as
// UIMessage-format JSON rows.
//
// Durability = WAL + transactions, not tmp/fsync/rename.

import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { z } from "zod";
import { log } from "./log.ts";
import { MemoryContexts, messageText } from "./memory.ts";
import { MemoryQueue } from "./memory-queue.ts";
import type { MemoryDocument } from "./hindsight.ts";

// ---------- identity ----------

// The channel address IS the conversation identity (DESIGN.md, App
// channel): a Telegram DM or forum topic, or an app conversation keyed by
// a client-minted id. Routing picks the door on this kind alone. The app
// member's Telegram coordinates are literal-0 fillers — an app address
// has none; the typed zeros keep existing coordinate reads on the union
// honest (always a number, never a real chat) instead of forcing every
// telegram-side reader to re-narrow.
export type ConversationAddress =
	| { kind: "dm"; chatId: number }
	| { kind: "topic"; chatId: number; threadId: number }
	| { kind: "app"; appId: string; chatId: 0; threadId: 0 };

export const APP_ID_PREFIX = "app/";

// App ids are client-minted but not arbitrary: the id rides the "app/"
// conversation id and an HTTP path segment, so it stays url-safe and
// slash-free (a uuid or nanoid fits). Validated at addressId — the single
// writer of the format — so a malformed id can never reach the store.
export const appIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "app ids are [A-Za-z0-9_-], 1-64 chars");

export function addressId(addr: ConversationAddress): string {
	if (addr.kind === "dm") return `dm:${addr.chatId}`;
	if (addr.kind === "topic") return `topic:${addr.chatId}:${addr.threadId}`;
	return `${APP_ID_PREFIX}${appIdSchema.parse(addr.appId)}`;
}

// The one well-formed way to build an app address — validated here and
// again in addressId so a client-minted id can never smuggle a path
// segment or a slash into the conversation id.
export function appAddress(appId: string): ConversationAddress {
	return { kind: "app", appId: appIdSchema.parse(appId), chatId: 0, threadId: 0 };
}

// The channel a conversation id belongs to — the address is the id, so
// the prefix is the whole discriminant. chat_id/thread_id are only the
// decoded Telegram coordinates; nothing app-side may read them.
export function channelOf(conversationId: string): "telegram" | "app" {
	return conversationId.startsWith(APP_ID_PREFIX) ? "app" : "telegram";
}

// ---------- types ----------

export interface Conversation {
	id: string;
	// The Telegram coordinates decoded from the id — real only on
	// dm:/topic: conversations. App rows store 0/NULL (the columns are
	// legacy NOT NULL): an app conversation has no Telegram door, and
	// channelOf(id) is the routing check, never these fields.
	chatId: number;
	threadId: number | null;
	title: string | null;
	// Telegram handed this topic a placeholder name (forum_topic_created
	// is_name_implicit) — the bot owes it a real one. Cleared by any
	// explicit rename or a successful auto-title.
	titleImplicit: boolean;
	// Retired with /model and /think — the mini app (config) owns model
	// and thinking, and nothing reads these at turn time. Columns persist
	// for existing DBs, same ruling as cwd.
	model: string | null;
	thinking: string | null;
	voice: boolean;
	memoryExcluded: boolean; // operator opt-out: this topic sends/recalls no memory
	epoch: number;
	createdAt: string;
}

export interface ConversationMetaPatch {
	title?: string;
	titleImplicit?: boolean;
	model?: string | null;
	thinking?: string | null;
	voice?: boolean;
	memoryExcluded?: boolean;
}

// A compaction pointer (DESIGN.md, Compaction). Rows append forever —
// audit trail; the latest per conversation is the active boundary.
export interface Compaction {
	boundarySeq: number;
	summary: string;
	tokensBefore: number;
	model: string;
	createdAt: string;
}

export interface ConversationStore {
	// The shared handle — memory-queue, memory-contexts, and the outage
	// tracker each own one table in the same database file.
	readonly db: Database;
	readonly memoryQueue: MemoryQueue;
	readonly memoryContexts: MemoryContexts;
	// The active compaction pointer (latest row) — null = uncompacted.
	// The compactions table itself is append-only audit; only the newest
	// row per conversation steers the model view.
	getCompaction(id: string): Compaction | null;
	setCompaction(id: string, compaction: Compaction): void;
	// Get-or-create by channel address. New conversations start at epoch 0.
	// The cwd column still exists in the table (NOT NULL, no default —
	// existing DBs need it stamped) but cwd is no longer per-conversation
	// state: tools always run in the deployment workspace.
	resolve(addr: ConversationAddress, defaultCwd: string): Conversation;
	get(id: string): Conversation | null;
	setMeta(id: string, patch: ConversationMetaPatch): void;
	// Settings changes and cancellation bump the epoch; in-flight turns
	// fence themselves against it.
	bumpEpoch(id: string): number;
	// Settings patch + epoch bump in one transaction — a settings write
	// that fences in-flight turns must never land half-applied.
	applySettings(id: string, patch: ConversationMetaPatch): number;
	// Append UIMessages in one transaction; seq is assigned here.
	// anchorSeq marks a response with the seq of the user event that
	// triggered its turn — history() uses it for causal ordering.
	append(id: string, messages: UIMessage[], opts?: {
		anchorSeq?: number | null;
		memory?: { target: string; document: MemoryDocument };
	}): void;
	// The model-facing view: causal order, not arrival order. Anchored
	// assistant events sort immediately after their triggering user
	// event; everything else falls back to seq.
	history(id: string): UIMessage[];
	// Same causal view with event seqs — memory recall blocks anchor to
	// the triggering user message's seq, so interleaving needs positions.
	historyEntries(id: string): { seq: number; message: UIMessage }[];
	// The causal view with anchors — compaction's cut rule needs to know
	// which responses belong to which user events (exchange completeness).
	historyDetail(id: string): { seq: number; anchorSeq: number | null; message: UIMessage }[];
	// What a turn actually sees (DESIGN.md, Compaction): the causal view
	// cut at the active boundary, with the summary message prepended.
	// The cut is on causal position — (anchorSeq ?? seq) > boundarySeq —
	// so a late answer to a folded question rides into the summary with
	// it instead of stranding, orphaned, in the tail. historyEntries
	// above stays the full, unbounded record.
	modelEntries(id: string): { seq: number; message: UIMessage }[];
	// Seq of the newest user event — a turn's response anchors to it.
	lastUserSeq(id: string): number | null;
	// Full-text search over user/assistant event text (DESIGN.md, Chat
	// search). Memory-excluded conversations are filtered at query time
	// against the live flag — retroactive. Empty when the query has no
	// searchable terms. Rank-best-first, bounded by limit.
	searchHistory(query: string, limit: number): HistoryHit[];
	// Arrival-ordered window around one event — paging context around a
	// search hit. No exclusion check here: the tool checks the live flag
	// before calling, the way search filters it in SQL.
	eventContext(id: string, seq: number, window: number): HistoryContextRow[];
	// The app channel's own pool, most recently active first — the two
	// pools never mix, so the list is filtered on the id prefix, not a
	// flag (DESIGN.md, App channel).
	listAppConversations(): AppConversationSummary[];
	close(): void;
}

// A chat-search hit: the addressing a context page needs, plus the text
// the tool shapes into a snippet.
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
	text: string;
	createdAt: string;
}

// One row of the app conversation list. id is the full address
// ("app/<appId>") — the prefix is the channel marker; the client's minted
// id is the part after it.
export interface AppConversationSummary {
	id: string;
	title: string | null;
	createdAt: string;
	// Newest event's timestamp, or createdAt for a conversation nobody
	// has spoken in yet — the list's ordering.
	updatedAt: string;
	// The newest event's text, capped for the list row. "" when the
	// latest event carries no text parts (an attachment-only message).
	preview: string;
}

// ---------- store ----------

interface Row {
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
	epoch: number;
	created_at: string;
}

// Disk state is a boundary: history rows are validated on read, not
// trusted. Parts stay loosely typed — the runtime's converters own the
// per-part semantics — and a row that isn't a message envelope at all
// degrades to a placeholder text part, never a throw: one malformed row
// must not kill every future turn in its conversation.
const uiMessageSchema = z.looseObject({
	id: z.string(),
	role: z.enum(["system", "user", "assistant"]),
	parts: z.array(z.looseObject({ type: z.string() })),
});

const roleSchema = z.enum(["system", "user", "assistant"]);

// One corrupt row degrades to a readable placeholder in its original
// position (seq/anchor preserved) — the turn sees a note where a message
// was, not a parse error that fails every future turn identically.
function corruptPlaceholder(seq: number, role: string): UIMessage {
	const parsed = roleSchema.safeParse(role);
	return {
		id: `corrupt-${seq}`,
		role: parsed.success ? parsed.data : "user",
		parts: [
			{
				type: "text",
				text: `[unreadable history row seq ${seq} — stored message failed validation. Any attachment it carried may still be readable with read_file or bash tools.]`,
			},
		],
	};
}

// Rows are versioned envelopes {"v":1,"message":…} — the SDK owns the
// part shapes, so every row stamps the format that wrote it (DESIGN.md,
// History). Bare rows are pre-envelope legacy and still read; openStore
// migrates them once at open.
function envelopeOf(raw: unknown): unknown {
	if (
		typeof raw === "object" && raw !== null && "v" in raw &&
		(raw as { v?: unknown }).v === 1 && "message" in raw
	) {
		return (raw as { message: unknown }).message;
	}
	return raw;
}

// The compacted view's synthetic first message (DESIGN.md, Compaction):
// user role, explicit framing — the model reads carried context, not a
// forged transcript. seq = the boundary, so causal sorting keeps it first.
export function summaryMessage(compaction: Compaction): UIMessage {
	return {
		id: `compact-${compaction.boundarySeq}`,
		role: "user",
		parts: [
			{
				type: "text",
				text: `[history compacted — the summary below replaces everything before seq ${compaction.boundarySeq}; treat it as accurate carried context, not as a message anyone sent]\n\n${compaction.summary}`,
			},
		],
	};
}

function toConversation(r: Row): Conversation {
	return {
		id: r.id,
		chatId: r.chat_id,
		threadId: r.thread_id,
		title: r.title,
		titleImplicit: r.title_implicit !== 0,
		model: r.model,
		thinking: r.thinking,
		voice: r.voice !== 0,
		memoryExcluded: r.memory_excluded !== 0,
		epoch: r.epoch,
		createdAt: r.created_at,
	};
}

// The FTS-indexed text of one event row: concatenated text parts only.
// Written against a row qualifier (new/old/events) so triggers and the
// backfill SELECT share it. Total over any stored bytes — a corrupt
// row indexes as empty, never fails its INSERT (corruption still warns
// at read time, where the placeholder degrades it).
function ftsTextOf(qual: string): string {
	return (
		`(CASE WHEN json_valid(${qual}.data) THEN ` +
		`(SELECT coalesce(group_concat(json_extract(value,'$.text'),' '), '') ` +
		`FROM json_each(json_extract(${qual}.data,'$.message.parts')) ` +
		`WHERE json_extract(value,'$.type')='text') ELSE '' END)`
	);
}

// Plain terms in, quoted FTS5 AND out — no query syntax reaches MATCH:
// each whitespace-separated term becomes a double-quoted phrase, so
// operators and punctuation are literal text. Null = no searchable
// terms (the search answers empty, it doesn't throw).
export function toFtsQuery(query: string): string | null {
	const terms = query
		.split(/\s+/)
		.map((t) => t.replace(/"/g, "").trim())
		.filter((t) => t !== "");
	if (terms.length === 0) return null;
	return terms.map((t) => `"${t}"`).join(" ");
}

// Parse one event row's envelope — null when the row is unreadable.
// The caller decides: history degrades to a placeholder in position,
// search and context skip the row. Warns either way — a silent skip
// would hide corruption.
function parseEvent(conversation: string, seq: number, role: string, data: string): UIMessage | null {
	let raw: unknown;
	try {
		raw = JSON.parse(data);
	} catch (err) {
		log.warn("corrupt history row — degrading to placeholder", {
			conversation,
			seq,
			error: (err as Error).message,
		});
		return null;
	}
	const parsed = uiMessageSchema.safeParse(envelopeOf(raw));
	if (!parsed.success) {
		log.warn("corrupt history row — degrading to placeholder", {
			conversation,
			seq,
			error: parsed.error.message,
		});
		return null;
	}
	return parsed.data as UIMessage;
}

export function openStore(dbPath: string): ConversationStore {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	// Telegram acknowledges an update after its inbox insert. WAL/NORMAL
	// survives a process crash, but a host power loss can discard an
	// acknowledged commit; FULL syncs each commit before we return.
	db.run("PRAGMA synchronous = FULL");
	db.run("PRAGMA foreign_keys = ON");
	db.run(`
		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			chat_id INTEGER NOT NULL,
			thread_id INTEGER,
			title TEXT,
			title_implicit INTEGER NOT NULL DEFAULT 0,
			cwd TEXT NOT NULL,
			model TEXT,
			thinking TEXT,
			voice INTEGER NOT NULL DEFAULT 0,
			epoch INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`);
	// Existing DBs predate title_implicit — additive column, no rebuild.
	const convCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(conversations)")
			.all()
			.map((c) => c.name),
	);
	if (!convCols.has("title_implicit")) {
		db.run("ALTER TABLE conversations ADD COLUMN title_implicit INTEGER NOT NULL DEFAULT 0");
	}
	if (!convCols.has("voice")) {
		db.run("ALTER TABLE conversations ADD COLUMN voice INTEGER NOT NULL DEFAULT 0");
	}
	if (!convCols.has("memory_excluded")) {
		db.run("ALTER TABLE conversations ADD COLUMN memory_excluded INTEGER NOT NULL DEFAULT 0");
	}
	db.run(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			data TEXT NOT NULL,
			anchor_seq INTEGER,
			created_at TEXT NOT NULL,
			UNIQUE(conversation_id, seq)
		)`);
	// Existing DBs predate anchor_seq — additive column, no rebuild.
	const eventCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(events)")
			.all()
			.map((c) => c.name),
	);
	if (!eventCols.has("anchor_seq")) {
		db.run("ALTER TABLE events ADD COLUMN anchor_seq INTEGER");
	}
	// Chat search (DESIGN.md): a contentless FTS5 index over user and
	// assistant event text, kept by triggers. Contentless, not
	// external-content — events stores JSON envelopes, so there is no
	// plain-text content column to point at; the indexed value is the
	// extracted projection below. System events never enter (the WHEN
	// clauses) and neither do tool payloads (the text-parts-only
	// projection). Deletes stay honest through the delete trigger.
	// Created before the envelope migration further down so the update
	// trigger re-indexes migrated rows.
	const ftsFresh =
		db.query<{ n: number }, []>(
			"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'events_fts'",
		).get()?.n === 0;
	db.run(
		"CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='', content_rowid='id', tokenize='porter')",
	);
	db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events
		WHEN NEW.role IN ('user','assistant')
		BEGIN INSERT INTO events_fts(rowid, text) VALUES (new.id, ${ftsTextOf("new")}); END`);
	db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events
		WHEN OLD.role IN ('user','assistant')
		BEGIN INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, ${ftsTextOf("old")}); END`);
	db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events
		WHEN NEW.role IN ('user','assistant')
		BEGIN INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, ${ftsTextOf("old")});
		INSERT INTO events_fts(rowid, text) VALUES (new.id, ${ftsTextOf("new")}); END`);
	// Upgrading DBs predate the index — backfill once, from the same
	// projection the triggers use. In a fresh DB this selects nothing.
	if (ftsFresh) {
		db.run(`INSERT INTO events_fts(rowid, text)
			SELECT id, ${ftsTextOf("events")} FROM events WHERE role IN ('user','assistant')`);
	}

	const memoryQueue = new MemoryQueue(db);
	const memoryContexts = new MemoryContexts(db);
	// Compaction pointers — append-only audit; the newest row per
	// conversation is the active boundary (DESIGN.md, Compaction).
	db.run(`
		CREATE TABLE IF NOT EXISTS compactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			boundary_seq INTEGER NOT NULL,
			summary TEXT NOT NULL,
			tokens_before INTEGER NOT NULL,
			model TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`);
	// Legacy rows predate the versioned envelope — wrap them once, in
	// place, before anything reads them this boot. Only well-formed bare
	// UIMessage objects match (top-level string `id`); corrupt rows are
	// left alone and keep degrading to placeholders on read.
	const bare = db
		.query<{ n: number }, []>(
			`SELECT COUNT(*) AS n FROM events
			 WHERE json_valid(data)
			   AND json_type(data, '$.v') IS NULL
			   AND json_type(data, '$.message') IS NULL
			   AND json_type(data, '$.id') = 'text'`,
		)
		.get()?.n ?? 0;
	if (bare > 0) {
		db.run(
			`UPDATE events SET data = json_object('v', 1, 'message', json(data))
			 WHERE json_valid(data)
			   AND json_type(data, '$.v') IS NULL
			   AND json_type(data, '$.message') IS NULL
			   AND json_type(data, '$.id') = 'text'`,
		);
		log.info("history payload envelopes migrated", { rows: bare });
	}
	const qCompaction = db.query<
		{ boundary_seq: number; summary: string; tokens_before: number; model: string; created_at: string },
		[string]
	>(
		"SELECT boundary_seq, summary, tokens_before, model, created_at FROM compactions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
	);
	const qInsertCompaction = db.query(
		"INSERT INTO compactions (conversation_id, boundary_seq, summary, tokens_before, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const qGet = db.query<Row, [string]>("SELECT * FROM conversations WHERE id = ?");
	const qInsertConv = db.query(
		`INSERT INTO conversations (id, chat_id, thread_id, title, cwd, created_at)
		 VALUES (?, ?, ?, NULL, ?, ?)`,
	);
	const qHistory = db.query<
		{ seq: number; anchor_seq: number | null; role: string; data: string },
		[string]
	>(
		"SELECT seq, anchor_seq, role, data FROM events WHERE conversation_id = ? ORDER BY seq",
	);
	const qLastUserSeq = db.query<{ seq: number }, [string]>(
		"SELECT seq FROM events WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1",
	);
	const qNextSeq = db.query<{ n: number | null }, [string]>(
		"SELECT MAX(seq) AS n FROM events WHERE conversation_id = ?",
	);
	const qInsertEvent = db.query(
		"INSERT INTO events (conversation_id, seq, role, data, anchor_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const qEpoch = db.query<{ epoch: number }, [string]>(
		"SELECT epoch FROM conversations WHERE id = ?",
	);
	// Chat search: FTS rowids join back to events for the addressable
	// hit, conversations for the title and the live exclusion flag.
	// Rank-best-first — FTS5's default rank orders best match first.
	const qSearch = db.query<
		{ cid: string; seq: number; role: string; data: string; created_at: string; title: string | null },
		[string, number]
	>(
		`SELECT e.conversation_id AS cid, e.seq AS seq, e.role AS role,
			e.data AS data, e.created_at AS created_at, c.title AS title
		FROM events_fts
		JOIN events e ON events_fts.rowid = e.id
		JOIN conversations c ON c.id = e.conversation_id
		WHERE events_fts MATCH ? AND c.memory_excluded = 0
		ORDER BY rank LIMIT ?`,
	);
	const qContext = db.query<
		{ seq: number; role: string; data: string; created_at: string },
		[string, number, number]
	>(
		`SELECT seq, role, data, created_at FROM events
		WHERE conversation_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
	);
	// The app channel's own pool — the id prefix is the channel marker.
	const qListApp = db.query<
		{ id: string; title: string | null; created_at: string },
		[]
	>(
		`SELECT id, title, created_at FROM conversations
		WHERE id LIKE 'app/%' ORDER BY created_at, rowid`,
	);
	// A list row's freshness + subtitle: the newest event's timestamp and
	// its text projection (empty when it carries no text parts). The
	// rowid rides along as the activity order — created_at ties within a
	// millisecond can't order two writes.
	const qLastAppEvent = db.query<
		{ id: number; seq: number; role: string; data: string; created_at: string },
		[string]
	>(
		`SELECT id, seq, role, data, created_at FROM events
		WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1`,
	);

	function applyPatch(id: string, patch: ConversationMetaPatch): void {
		const sets: string[] = [];
		const vals: (string | number | null)[] = [];
		if (patch.title !== undefined) {
			sets.push("title = ?");
			vals.push(patch.title);
		}
		if (patch.titleImplicit !== undefined) {
			sets.push("title_implicit = ?");
			vals.push(patch.titleImplicit ? 1 : 0);
		}
		if (patch.model !== undefined) {
			sets.push("model = ?");
			vals.push(patch.model);
		}
		if (patch.thinking !== undefined) {
			sets.push("thinking = ?");
			vals.push(patch.thinking);
		}
		if (patch.voice !== undefined) {
			sets.push("voice = ?");
			vals.push(patch.voice ? 1 : 0);
		}
		if (patch.memoryExcluded !== undefined) {
			sets.push("memory_excluded = ?");
			vals.push(patch.memoryExcluded ? 1 : 0);
		}
		if (sets.length === 0) return;
		vals.push(id);
		db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, vals);
	}

	function bump(id: string): number {
		db.run("UPDATE conversations SET epoch = epoch + 1 WHERE id = ?", [id]);
		const row = qEpoch.get(id);
		if (!row) throw new Error(`conversation ${id} not found`);
		return row.epoch;
	}

	return {
		db,
		memoryQueue,
		memoryContexts,

		getCompaction(id) {
			const row = qCompaction.get(id);
			return row
				? {
						boundarySeq: row.boundary_seq,
						summary: row.summary,
						tokensBefore: row.tokens_before,
						model: row.model,
						createdAt: row.created_at,
					}
				: null;
		},

		setCompaction(id, compaction) {
			qInsertCompaction.run(
					id,
					compaction.boundarySeq,
					compaction.summary,
					compaction.tokensBefore,
					compaction.model,
					compaction.createdAt,
				);
		},

		resolve(addr, defaultCwd) {
			const id = addressId(addr);
			const existing = qGet.get(id);
			if (existing) return toConversation(existing);
			// chat_id/thread_id are the decoded Telegram coordinates — on
			// an app address they're the typed-0 fillers, so the row
			// carries 0/NULL for the legacy NOT NULL schema. Nothing reads
			// them on an app id: channelOf routes on the id prefix
			// (DESIGN.md, App channel).
			qInsertConv.run(
				id,
				addr.chatId,
				addr.kind === "topic" ? addr.threadId : null,
				defaultCwd,
				new Date().toISOString(),
			);
			const created = qGet.get(id);
			if (!created) throw new Error(`conversation ${id} insert failed`);
			return toConversation(created);
		},

		get(id) {
			const row = qGet.get(id);
			return row ? toConversation(row) : null;
		},

		setMeta(id, patch) {
			applyPatch(id, patch);
		},

		bumpEpoch(id) {
			return bump(id);
		},

		applySettings(id, patch) {
			return db.transaction(() => {
				applyPatch(id, patch);
				return bump(id);
			})();
		},

		append(id, messages, opts) {
			let operation: string | undefined;
			db.transaction(() => {
				const start = qNextSeq.get(id)?.n ?? 0;
				const now = new Date().toISOString();
				for (const [i, m] of messages.entries()) {
					qInsertEvent.run(
						id,
						start + i + 1,
						m.role,
						JSON.stringify({ v: 1, message: m }),
						opts?.anchorSeq ?? null,
						now,
					);
				}
				if (opts?.memory) {
					if (opts.memory.document.conversationId !== id ||
						!messages.some((message) => message.role === "assistant" &&
							opts.memory!.document.sourceIds.includes(message.id))) {
						throw new Error("Memory retention must accompany its completed assistant event");
					}
					operation = memoryQueue.enqueue(opts.memory.target, opts.memory.document);
				}
			})();
			if (operation) log.info("memory queued", {
				conversation: id, operation, document: opts?.memory?.document.id,
			});
		},

		lastUserSeq(id) {
			return qLastUserSeq.get(id)?.seq ?? null;
		},

		searchHistory(query, limit) {
			const match = toFtsQuery(query);
			if (match === null) return [];
			const hits: HistoryHit[] = [];
			for (const r of qSearch.all(match, Math.max(1, Math.min(limit, 50)))) {
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
		},

		eventContext(id, seq, window) {
			const w = Math.max(0, Math.min(window, 25));
			const rows: HistoryContextRow[] = [];
			for (const r of qContext.all(id, seq - w, seq + w)) {
				const message = parseEvent(id, r.seq, r.role, r.data);
				if (message === null) continue;
				rows.push({ seq: r.seq, role: r.role, text: messageText(message), createdAt: r.created_at });
			}
			return rows;
		},

		listAppConversations() {
			// One operator, one pool — the list is small; a per-row latest
			// event lookup is cheaper than the join bookkeeping.
			const out: (AppConversationSummary & { activity: number })[] = [];
			for (const r of qListApp.all()) {
				const last = qLastAppEvent.get(r.id);
				const message = last === null ? null : parseEvent(r.id, last.seq, last.role, last.data);
				out.push({
					id: r.id,
					title: r.title,
					createdAt: r.created_at,
					updatedAt: last?.created_at ?? r.created_at,
					preview: message === null ? "" : messageText(message).slice(0, 200),
					activity: last?.id ?? 0,
				});
			}
			out.sort((a, b) => b.activity - a.activity);
			return out.map(({ activity: _activity, ...summary }) => summary);
		},

		history(id) {
			return this.historyEntries(id).map((e) => e.message);
		},

		historyEntries(id) {
			return this.historyDetail(id).map((e) => ({ seq: e.seq, message: e.message }));
		},

		historyDetail(id) {
			const rows = qHistory.all(id).map((r) => ({
				seq: r.seq,
				anchorSeq: r.anchor_seq,
				message: parseEvent(id, r.seq, r.role, r.data) ?? corruptPlaceholder(r.seq, r.role),
			}));
			// Arrival order stays on disk; this view sorts each anchored
			// response right after the user event that triggered its turn.
			// Key = anchor ?? seq, tiebreak = seq — an anchored response's
			// anchor always precedes its own seq, so it lands just after
			// its user event and before anything that arrived later.
			rows.sort((a, b) => {
				const ka = a.anchorSeq ?? a.seq;
				const kb = b.anchorSeq ?? b.seq;
				return ka - kb || a.seq - b.seq;
			});
			return rows;
		},

		modelEntries(id) {
			const compaction = this.getCompaction(id);
			// Filter on the same key the causal sort uses: an anchored
			// response to a compacted user event has a high seq but an
			// early causal position — it belongs to the summarized span,
			// not the tail (DESIGN.md, Compaction).
			const entries = this.historyDetail(id)
				.filter((e) => compaction === null || (e.anchorSeq ?? e.seq) > compaction.boundarySeq)
				.map((e) => ({ seq: e.seq, message: e.message }));
			return compaction === null
				? entries
				: [{ seq: compaction.boundarySeq, message: summaryMessage(compaction) }, ...entries];
		},

		close() {
			db.close();
		},
	};
}
