// Conversation store — SQLite (bun:sqlite, WAL): meta (model/thinking
// overrides, epoch) and the event history as UIMessage JSON rows, keyed by
// channel address. Durability = WAL + transactions, not tmp/fsync/rename.

import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { z } from "zod";
import { log } from "./log.ts";
import { splitModelRef, thinkingLevels, type Config, type ThinkingLevel } from "./config.ts";
import { MemoryContexts, type MemoryEligibility, messageText } from "./memory.ts";
import { MemoryDestinations } from "./memory-destinations.ts";
import { MemoryQueue } from "./memory-queue.ts";
import { compactionSummaryId, corruptRowId } from "./tags.ts";
import type { MemoryDocument } from "./hindsight.ts";

// The channel address IS the conversation identity: routing picks the
// door on this kind alone. The app member's zeros are fillers, not real
// coordinates — typed so the union's numeric reads stay honest.
export type ConversationAddress =
	| { kind: "dm"; chatId: number }
	| { kind: "topic"; chatId: number; threadId: number }
	// Guest mode: one conversation per (chat, summoner). chatId is the
	// summoned chat (negative for groups), userId the summoner (positive).
	| { kind: "guest"; chatId: number; userId: number }
	| { kind: "app"; appId: string; chatId: 0; threadId: 0 };

export const APP_ID_PREFIX = "app/";

// App ids are client-minted but ride the "app/" conversation id and
// an HTTP path segment, so they must stay url-safe and slash-free.
export const appIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "app ids are [A-Za-z0-9_-], 1-64 chars");

// dm:<chat>:<n> — n is a creation ordinal that only grows. Not a
// ConversationAddress member: resolve() must never mint one.
export interface RollingDmAddress {
	kind: "rolling";
	chatId: number;
	ordinal: number;
}

export type ParsedAddress = ConversationAddress | RollingDmAddress;

// The single builder for ids and lane keys — malformed addresses fail
// here, not silently downstream.
export function formatAddress(addr: ParsedAddress): string {
	if (addr.kind === "dm") return `dm:${addr.chatId}`;
	if (addr.kind === "rolling") return `dm:${addr.chatId}:${addr.ordinal}`;
	if (addr.kind === "topic") return `topic:${addr.chatId}:${addr.threadId}`;
	if (addr.kind === "guest") return `guest:${addr.chatId}:${addr.userId}`;
	return `${APP_ID_PREFIX}${appIdSchema.parse(addr.appId)}`;
}

const dmIdRe = /^dm:(-?\d+)$/;
const rollingDmIdRe = /^dm:(-?\d+):([1-9]\d*)$/;
const topicIdRe = /^topic:(-?\d+):(-?\d+)$/;
const guestIdRe = /^guest:(-?\d+):(-?\d+)$/;

// Safe integer coordinates out of a regex match — null when a capture
// exceeds what a Number can hold exactly.
function coordsOf(match: RegExpExecArray | null): number[] | null {
	if (match === null) return null;
	const nums = match.slice(1).map(Number);
	return nums.every(Number.isSafeInteger) ? nums : null;
}

// The single parser — parseAddress ∘ formatAddress is the identity on
// every id in the system. Null on anything else: callers route on the
// null, never guess. Rolling ordinals decode as [1-9]\d* — rollDm mints
// them and never rewrites them, so a zero or leading-zero ordinal is not
// an id.
export function parseAddress(id: string): ParsedAddress | null {
	if (id.startsWith(APP_ID_PREFIX)) {
		const appId = appIdSchema.safeParse(id.slice(APP_ID_PREFIX.length));
		return appId.success ? { kind: "app", appId: appId.data, chatId: 0, threadId: 0 } : null;
	}
	const rolling = coordsOf(rollingDmIdRe.exec(id));
	if (rolling !== null) return { kind: "rolling", chatId: rolling[0]!, ordinal: rolling[1]! };
	const dm = coordsOf(dmIdRe.exec(id));
	if (dm !== null) return { kind: "dm", chatId: dm[0]! };
	const topic = coordsOf(topicIdRe.exec(id));
	if (topic !== null) return { kind: "topic", chatId: topic[0]!, threadId: topic[1]! };
	const guest = coordsOf(guestIdRe.exec(id));
	if (guest !== null) return { kind: "guest", chatId: guest[0]!, userId: guest[1]! };
	return null;
}

export function appIdOf(conversationId: string): string | null {
	const parsed = parseAddress(conversationId);
	return parsed !== null && parsed.kind === "app" ? parsed.appId : null;
}

export function appAddress(appId: string): ConversationAddress {
	return { kind: "app", appId: appIdSchema.parse(appId), chatId: 0, threadId: 0 };
}

// The channel an id belongs to — the prefix is the whole discriminant.
// "guest" is its own channel, not a telegram flavor: tool assembly and
// delivery branch on it.
export function channelOf(conversationId: string): "telegram" | "app" | "guest" {
	if (conversationId.startsWith(APP_ID_PREFIX)) return "app";
	if (conversationId.startsWith("guest:")) return "guest";
	return "telegram";
}

export function guestAddress(chatId: number, userId: number): ConversationAddress {
	return { kind: "guest", chatId, userId };
}

export interface Conversation {
	id: string;
	// Real only on dm:/topic:. App rows store 0/NULL (the columns are
	// legacy NOT NULL) — channelOf(id) is the routing check, never these.
	chatId: number;
	threadId: number | null;
	title: string | null;
	// Telegram handed this topic a placeholder name — the bot owes it a
	// real one. Cleared by any explicit rename or a successful auto-title.
	titleImplicit: boolean;
	// App conversations own durable model/thinking snapshots. Telegram
	// ignores these columns and uses its one shared config selection.
	model: string | null;
	thinking: string | null;
	voice: boolean;
	memoryExcluded: boolean; // operator opt-out: this topic sends/recalls no memory
	persona: "personal" | "guest"; // prompt class + sandbox tool filter (Guest mode)
	// App-channel declutter: hidden from the rail, still answerable.
	// Any appended event clears it (design/app.md → Archiving).
	archivedAt: string | null;
	epoch: number;
	createdAt: string;
}

export interface ModelSettings {
	model: string;
	thinking: ThinkingLevel;
}
const modelSettingsSchema = z.object({
	model: z.string().min(1),
	thinking: z.enum(thinkingLevels),
});

// Called at admission (and manual compaction), never at submit time:
// a queued turn sees the latest settings, a running turn keeps its copy.
export function captureConversationSettings(
	store: ConversationStore,
	conv: Conversation,
	cfg: Config,
): Conversation & ModelSettings {
	const settings: ModelSettings =
		channelOf(conv.id) === "app"
			? store.initializeAppSettings(conv.id, cfg)
			: { model: cfg.telegram.model ?? cfg.model, thinking: cfg.telegram.thinking ?? cfg.thinking };
	return { ...conv, ...settings };
}

// Provider edits must not strand persisted app selections; a refusal
// leaves disk untouched.
export function prepareAppSettingsForConfig(
	store: ConversationStore,
	previous: Config,
	next: Config,
): void {
	const rows = store.listAppConversations().map((conv) => ({
		id: conv.id,
		model: store.get(conv.id)!.model ?? previous.model,
	}));
	z.array(z.object({ id: z.string(), model: z.string() }))
		.superRefine((selections, ctx) => {
			for (const row of selections) {
				const { provider } = splitModelRef(row.model);
				if (!(provider in next.providers)) {
					ctx.addIssue({
						code: "custom",
						path: [row.id],
						message: `provider "${provider}" is still selected by ${row.id}; change that conversation's model before removing it`,
					});
				}
			}
		})
		.parse(rows);
	store.db.transaction(() => {
		for (const row of rows) store.initializeAppSettings(row.id, previous);
	})();
}

export interface ConversationMetaPatch {
	title?: string;
	titleImplicit?: boolean;
	model?: string | null;
	thinking?: string | null;
	voice?: boolean;
	memoryExcluded?: boolean;
	persona?: "personal" | "guest";
	archived?: boolean;
}

// A compaction pointer; rows append forever, the latest per
// conversation is the active boundary. summaryEligible: derived text
// may reach memory-bound builders only when every event it was
// distilled from was eligible — store-stamped, never caller input (#85).
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

export interface ConversationStore {
	// Shared handle — the memory/outage modules each own tables in this file.
	readonly db: Database;
	readonly memoryQueue: MemoryQueue;
	readonly memoryContexts: MemoryContexts;
	// Boot records the live endpoint+bank so forget can reconstruct a
	// previous bank's client (#87).
	readonly memoryDestinations: MemoryDestinations;
	getCompaction(id: string): Compaction | null;
	setCompaction(id: string, compaction: CompactionWrite): void;
	// Get-or-create by address. The cwd column is legacy NOT NULL —
	// stamped, ignored. Private DMs route through rolling.ts: a legacy
	// dm:<chat> row here is history, never current.
	resolve(addr: ConversationAddress, defaultCwd: string, defaults?: ModelSettings): Conversation;
	get(id: string): Conversation | null;
	// Rolling DM: one current dm:<chat>:<n> per private chat; rollDm
	// creates dm:<chat>:<n+1> linked to the selected source and selects
	// it atomically. n is a creation high-water, never rewound by /back.
	currentDm(chatId: number): Conversation | null;
	rollDm(chatId: number, defaultCwd: string): Conversation;
	// Read-only predecessor — rolling private DMs in this chat only.
	previousDm(chatId: number): Conversation | null;
	// Atomically select the predecessor and reset the quiet-gap clock;
	// null = no state change. No history replayed; the caller owns logs
	// and pending input.
	backDm(chatId: number): Conversation | null;
	// Latest event/creation time, plus selected_at when current — the quiet-gap clock.
	lastActivityAt(id: string): string;
	// Highest event seq. The spin-off discard compares it against
	// fork-time seq: a change means operator input arrived.
	lastSeq(id: string): number | null;
	// Spin-off: copy model state into a fresh app conversation, one
	// transaction — every event verbatim, the latest compaction pointer,
	// every memory_contexts row. The memory queue is NOT replayed (copies
	// are already retained); the caller owns the `spin-off` log line.
	forkToApp(
		fromId: string,
		appId: string,
		defaultCwd: string,
		title: string,
		defaults?: ModelSettings,
	): Conversation;
	// Initialize missing app settings once, no reset, no epoch fence;
	// missing/non-app ids throw.
	initializeAppSettings(id: string, defaults: ModelSettings): ModelSettings;
	setMeta(id: string, patch: ConversationMetaPatch): void;
	// All guest conversations in a chat — closing guest access fences
	// their running turns.
	listGuestConversationIds(chatId: number): string[];
	// Settings changes and cancellation bump the epoch; in-flight turns
	// fence on it.
	bumpEpoch(id: string): number;
	// Frozen system-prompt snapshot; null = none yet (first turn, or cleared by compaction).
	promptSnapshot(id: string): { text: string; sources: string[] } | null;
	savePromptSnapshot(id: string, text: string, sources: string[]): void;
	// Compaction rewrites history — the prefix busts anyway, so the
	// snapshot rebuilds from current files on the next turn.
	clearPromptSnapshot(id: string): void;
	// Settings patch + epoch bump in one transaction — never half-applied.
	applySettings(id: string, patch: ConversationMetaPatch): number;
	// Append UIMessages in one transaction; seq is assigned here.
	// anchorSeq marks a response with the seq of the user event that
	// triggered its turn.
	append(
		id: string,
		messages: UIMessage[],
		opts?: {
			anchorSeq?: number | null;
			memory?: { target: string; document: MemoryDocument };
		},
	): void;
	// The causal view (anchored responses sort right after their user
	// event) as messages; historyEntries adds seqs (recall blocks need
	// positions); historyDetail adds anchors (compaction's cut rule).
	history(id: string): UIMessage[];
	historyEntries(id: string): { seq: number; message: UIMessage }[];
	historyDetail(id: string): { seq: number; anchorSeq: number | null; message: UIMessage }[];
	// What a turn sees: the causal view cut at the active boundary, the
	// summary prepended. The cut is on causal position — (anchorSeq ??
	// seq) > boundarySeq — so a late answer to a folded question rides
	// into the summary instead of stranding in the tail.
	modelEntries(id: string): { seq: number; message: UIMessage }[];
	// Seq of the newest user event — a turn's response anchors to it.
	lastUserSeq(id: string): number | null;
	// Every event's append-time stamp plus the summary's derived
	// eligibility (#85) — the filter input for memory-bound builders.
	// Re-enabling memory reads this, never the live flag: excluded-era
	// messages stay out of recall and retention retroactively.
	memoryEligibility(id: string): MemoryEligibility;
	// Full-text search over user/assistant event text. Excluded
	// conversations filter at query time against the live flag —
	// retroactive, unlike the event stamps. channelPrefix (a LIKE pattern
	// like "app/%") scopes the pool.
	searchHistory(query: string, limit: number, channelPrefix?: string): HistoryHit[];
	// Arrival-ordered window around one event. No exclusion check here —
	// the tool checks the live flag before calling.
	eventContext(id: string, seq: number, window: number): HistoryContextRow[];
	// The app channel's own pool, most recently active first — filtered
	// on the id prefix.
	listAppConversations(): AppConversationSummary[];
	// Drop a conversation and everything it owns (events fire the FTS
	// delete trigger). A live turn must be fenced first (runtime.stop) —
	// this only touches the store.
	deleteConversation(id: string): void;
	close(): void;
}

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

// One row of the app conversation list; id is the full "app/<appId>" address.
export interface AppConversationSummary {
	id: string;
	title: string | null;
	createdAt: string;
	// Newest event's timestamp, or createdAt if nobody spoke — the list's
	// ordering.
	updatedAt: string;
	// Newest event's text, capped; "" when no text parts.
	preview: string;
	// Non-null = archived: off the main rail, into the client's archived
	// section. The stamp, not a bool, so that section can sort by when
	// the row was shelved.
	archivedAt: string | null;
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
	// Prompt class: "guest" is the sandbox persona — no private files
	// in, nothing about the operator out. Frozen at creation.
	persona: string;
	epoch: number;
	created_at: string;
	previous_dm_id: string | null; // internal navigation link, never on the wire
	archived_at: string | null;
}

const privateChatIdSchema = z.number().int().positive();

// Only canonical rolling private DM identities can enter a back chain.
// Checking coordinates too prevents a malformed disk link crossing pools.
function rollingDmOrdinal(
	row: Pick<Row, "id" | "chat_id" | "thread_id">,
	chatId: number,
): number | null {
	const parsed = parseAddress(row.id);
	return parsed !== null &&
		parsed.kind === "rolling" &&
		parsed.chatId === chatId &&
		row.chat_id === chatId &&
		row.thread_id === null
		? parsed.ordinal
		: null;
}

// Disk state is a boundary: rows are validated on read, loosely (the
// runtime's converters own per-part semantics). A row that isn't an
// envelope degrades to a placeholder, never a throw — one malformed row
// must not kill every future turn.
const uiMessageSchema = z.looseObject({
	id: z.string(),
	role: z.enum(["system", "user", "assistant"]),
	parts: z.array(z.looseObject({ type: z.string() })),
});

const roleSchema = z.enum(["system", "user", "assistant"]);

// The placeholder keeps the row's position (seq/anchor preserved) — a
// note where a message was, not a parse error.
function corruptPlaceholder(seq: number, role: string): UIMessage {
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

// Rows are versioned envelopes {"v":1,"message":…} — every row stamps
// the format that wrote it (the SDK owns part shapes). Reads are
// envelope-only; straggler bare rows wrap once at open, below.
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

// The compacted view's synthetic first message: user role, explicit
// framing — carried context, not a forged transcript. seq = the
// boundary, so causal sorting keeps it first.
export function summaryMessage(compaction: Compaction): UIMessage {
	return {
		id: compactionSummaryId(compaction.boundarySeq),
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
		persona: r.persona === "guest" ? "guest" : "personal",
		archivedAt: r.archived_at,
		epoch: r.epoch,
		createdAt: r.created_at,
	};
}

// The FTS text of one row: concatenated text parts only, written
// against a row qualifier so triggers and backfill share it. Total over
// any stored bytes — a corrupt row indexes empty, never fails its INSERT.
function ftsTextOf(qual: string): string {
	return (
		`(CASE WHEN json_valid(${qual}.data) THEN ` +
		`(SELECT coalesce(group_concat(json_extract(value,'$.text'),' '), '') ` +
		`FROM json_each(json_extract(${qual}.data,'$.message.parts')) ` +
		`WHERE json_extract(value,'$.type')='text') ELSE '' END)`
	);
}

// Plain terms in, quoted FTS5 AND out — each term a double-quoted
// phrase, so no query syntax reaches MATCH. Null = no searchable terms.
export function toFtsQuery(query: string): string | null {
	const terms = query
		.split(/\s+/)
		.map((t) => t.replace(/"/g, "").trim())
		.filter((t) => t !== "");
	if (terms.length === 0) return null;
	return terms.map((t) => `"${t}"`).join(" ");
}

// One flat display line — list titles and previews are single-line
// labels, so markdown furniture comes off, or a reply that opens on a
// code block titles the row "```typescript const slug = …".
function flatLine(text: string): string {
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

// Parse one envelope — null when unreadable; history degrades to a
// placeholder, search and context skip. Warns either way: a silent skip
// would hide corruption.
function parseEvent(
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

export function openStore(dbPath: string): ConversationStore {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	// Telegram acks after the inbox insert; WAL/NORMAL survives a crash,
	// but host power loss could discard an acked commit — FULL syncs
	// before we return.
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
	if (!convCols.has("persona")) {
		db.run("ALTER TABLE conversations ADD COLUMN persona TEXT NOT NULL DEFAULT 'personal'");
	}
	if (!convCols.has("archived_at")) {
		db.run("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
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
			memory_eligible INTEGER NOT NULL DEFAULT 0,
			UNIQUE(conversation_id, seq)
		)`);
	const eventCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(events)")
			.all()
			.map((c) => c.name),
	);
	if (!eventCols.has("anchor_seq")) {
		db.run("ALTER TABLE events ADD COLUMN anchor_seq INTEGER");
	}
	// Stamped per event at append time (#85): the durable answer to "may
	// this text ever reach the memory service?" DEFAULT 0 keeps every
	// pre-stamp row ineligible — the append-time flag is unreconstructable,
	// and enabling memory must not silently backfill.
	if (!eventCols.has("memory_eligible")) {
		db.run("ALTER TABLE events ADD COLUMN memory_eligible INTEGER NOT NULL DEFAULT 0");
		const stamped = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n;
		log.info("event memory eligibility stamped — prior rows historical", {
			events: stamped ?? 0,
		});
	}
	// Contentless FTS5, not external-content — events stores JSON
	// envelopes, so there is no plain-text column to point at; the indexed
	// value is the extracted projection. Created before the envelope
	// migration below so the update trigger re-indexes migrated rows.
	const ftsFresh =
		db
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'events_fts'")
			.get()?.n === 0;
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
	// Backfill once for upgrading DBs, from the trigger's projection.
	if (ftsFresh) {
		db.run(`INSERT INTO events_fts(rowid, text)
			SELECT id, ${ftsTextOf("events")} FROM events WHERE role IN ('user','assistant')`);
	}

	const memoryQueue = new MemoryQueue(db);
	const memoryContexts = new MemoryContexts(db);
	const memoryDestinations = new MemoryDestinations(db);
	// Compaction pointers, append-only; the newest row per conversation
	// is the active boundary. summary_eligible DEFAULT 0 fails legacy
	// rows closed, the same way the event stamp does (#85).
	db.run(`
		CREATE TABLE IF NOT EXISTS compactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			boundary_seq INTEGER NOT NULL,
			summary TEXT NOT NULL,
			summary_eligible INTEGER NOT NULL DEFAULT 0,
			tokens_before INTEGER NOT NULL,
			model TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`);
	const compactCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(compactions)")
			.all()
			.map((c) => c.name),
	);
	if (!compactCols.has("summary_eligible")) {
		db.run("ALTER TABLE compactions ADD COLUMN summary_eligible INTEGER NOT NULL DEFAULT 0");
	}
	// Frozen system prompts (DESIGN.md → Cache stability): the bytes a
	// conversation started with, served verbatim — file edits load at
	// conversation boundaries, never mid-run, so a live prefix cache is
	// never rewritten.
	db.run(`
		CREATE TABLE IF NOT EXISTS prompt_snapshots (
			conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
			text TEXT NOT NULL,
			sources TEXT NOT NULL,
			built_at TEXT NOT NULL
		)`);
	// One current rolling DM per private chat; n only grows, so a
	// reverted db still mints fresh ids.
	db.run(`
		CREATE TABLE IF NOT EXISTS dm_rolls (
			chat_id INTEGER PRIMARY KEY,
			current_id TEXT NOT NULL REFERENCES conversations(id),
			n INTEGER NOT NULL
		)`);
	// Manual DM navigation is additive. The presence of the link column
	// is the one-time migration marker: never rebuild links on later boots,
	// or a /back → /new branch would silently become chronological again.
	const rollCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(dm_rolls)")
			.all()
			.map((c) => c.name),
	);
	db.transaction(() => {
		if (!convCols.has("previous_dm_id")) {
			db.run(
				"ALTER TABLE conversations ADD COLUMN previous_dm_id TEXT REFERENCES conversations(id) ON DELETE SET NULL",
			);
			const sessionsByChat = new Map<number, { id: string; ordinal: number }[]>();
			const rows = db
				.query<Pick<Row, "id" | "chat_id" | "thread_id">, []>(
					"SELECT id, chat_id, thread_id FROM conversations",
				)
				.all();
			for (const row of rows) {
				if (!privateChatIdSchema.safeParse(row.chat_id).success) continue;
				const ordinal = rollingDmOrdinal(row, row.chat_id);
				if (ordinal === null) continue;
				const sessions = sessionsByChat.get(row.chat_id) ?? [];
				sessions.push({ id: row.id, ordinal });
				sessionsByChat.set(row.chat_id, sessions);
			}
			// The numeric suffix is the creation high-water mark. Wall-clock
			// timestamps can run backwards; row insertion order is not identity.
			for (const sessions of sessionsByChat.values()) {
				sessions.sort((a, b) => a.ordinal - b.ordinal);
				let previous: string | null = null;
				for (const session of sessions) {
					db.run("UPDATE conversations SET previous_dm_id = ? WHERE id = ?", [
						previous,
						session.id,
					]);
					previous = session.id;
				}
			}
		}
		if (!rollCols.has("selected_at")) {
			db.run("ALTER TABLE dm_rolls ADD COLUMN selected_at TEXT");
		}
	})();
	// Legacy rows predate the envelope — wrap once, in place, before
	// any read this boot (reads are strict). Only well-formed bare
	// UIMessages match (top-level string `id`); corrupt rows degrade.
	const bare =
		db
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
		{
			boundary_seq: number;
			summary: string;
			summary_eligible: number;
			tokens_before: number;
			model: string;
			created_at: string;
		},
		[string]
	>(
		"SELECT boundary_seq, summary, summary_eligible, tokens_before, model, created_at FROM compactions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
	);
	const qInsertCompaction = db.query(
		"INSERT INTO compactions (conversation_id, boundary_seq, summary, summary_eligible, tokens_before, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const qGet = db.query<Row, [string]>("SELECT * FROM conversations WHERE id = ?");
	const qInsertConv = db.query(
		`INSERT INTO conversations (id, chat_id, thread_id, title, cwd, created_at)
		 VALUES (?, ?, ?, NULL, ?, ?)`,
	);
	const qDmRoll = db.query<{ current_id: string; n: number; selected_at: string | null }, [number]>(
		"SELECT current_id, n, selected_at FROM dm_rolls WHERE chat_id = ?",
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
		{ seq: number; anchor_seq: number | null; role: string; data: string },
		[string]
	>("SELECT seq, anchor_seq, role, data FROM events WHERE conversation_id = ? ORDER BY seq");
	const qLastUserSeq = db.query<{ seq: number }, [string]>(
		"SELECT seq FROM events WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1",
	);
	const qNextSeq = db.query<{ n: number | null }, [string]>(
		"SELECT MAX(seq) AS n FROM events WHERE conversation_id = ?",
	);
	// Memory-bound filter inputs (#85): eligible seqs + folded-span
	// ineligible count.
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
	// forkToApp's copy sources — events verbatim (created_at and the
	// eligibility stamp included, unlike the history view), and
	// memory_contexts with only the conversation_id swapped.
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
	const qContextsFor = db.query<
		{ anchor_seq: number; content: string; source_ids: string; created_at: string },
		[string]
	>(
		"SELECT anchor_seq, content, source_ids, created_at FROM memory_contexts WHERE conversation_id = ? ORDER BY anchor_seq",
	);
	const qInsertContext = db.query(
		"INSERT INTO memory_contexts (conversation_id, anchor_seq, content, source_ids, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const qEpoch = db.query<{ epoch: number }, [string]>(
		"SELECT epoch FROM conversations WHERE id = ?",
	);
	// FTS rowids join back to events for the hit, conversations for the
	// title and live exclusion flag; FTS5's default rank is best-first.
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
		{ id: string; title: string | null; created_at: string; archived_at: string | null },
		[]
	>(
		`SELECT id, title, created_at, archived_at FROM conversations
		WHERE id LIKE 'app/%' ORDER BY created_at, rowid`,
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
	const qDeleteConv = db.query("DELETE FROM conversations WHERE id = ?");

	function previousDmRow(chatId: number): Row | null {
		if (!privateChatIdSchema.safeParse(chatId).success) return null;
		const roll = qDmRoll.get(chatId);
		if (!roll) return null;
		const current = qGet.get(roll.current_id);
		if (!current || current.previous_dm_id === null) return null;
		const currentOrdinal = rollingDmOrdinal(current, chatId);
		if (currentOrdinal === null) return null;
		const previous = qGet.get(current.previous_dm_id);
		if (!previous || previous.id === current.id) return null;
		const previousOrdinal = rollingDmOrdinal(previous, chatId);
		// Every back step must decrease the creation ordinal, including
		// branch source links. A corrupt forward link can otherwise cycle.
		return previousOrdinal !== null && previousOrdinal < currentOrdinal ? previous : null;
	}

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
		if (patch.persona !== undefined) {
			sets.push("persona = ?");
			vals.push(patch.persona);
		}
		if (patch.archived !== undefined) {
			sets.push("archived_at = ?");
			vals.push(patch.archived ? new Date().toISOString() : null);
		}
		if (sets.length === 0) return;
		vals.push(id);
		db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, vals);
	}

	function initializeSettings(id: string, defaults: ModelSettings): ModelSettings {
		const row = qGet.get(id);
		if (!row || channelOf(id) !== "app") throw new Error(`no app conversation ${id}`);
		const settings = modelSettingsSchema.parse({
			model: row.model ?? defaults.model,
			thinking: row.thinking ?? defaults.thinking,
		});
		if (row.model === null || row.thinking === null) {
			applyPatch(id, settings);
			log.info("app conversation settings initialized", { conversation: id, ...settings });
		}
		return settings;
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
		memoryDestinations,

		getCompaction(id) {
			const row = qCompaction.get(id);
			return row
				? {
						boundarySeq: row.boundary_seq,
						summary: row.summary,
						summaryEligible: row.summary_eligible !== 0,
						tokensBefore: row.tokens_before,
						model: row.model,
						createdAt: row.created_at,
					}
				: null;
		},

		setCompaction(id, compaction) {
			// Derived text feeds memory-bound builders only when every event
			// the pointer folds (causal position ≤ boundary — the key
			// modelEntries cuts on) was eligible; a prior summary's span sits
			// below the new boundary, so one count covers repeated
			// compactions (#85).
			const foldedIneligible = qIneligibleFolded.get(id, compaction.boundarySeq)?.n ?? 0;
			qInsertCompaction.run(
				id,
				compaction.boundarySeq,
				compaction.summary,
				foldedIneligible === 0 ? 1 : 0,
				compaction.tokensBefore,
				compaction.model,
				compaction.createdAt,
			);
		},

		resolve(addr, defaultCwd, defaults) {
			return db.transaction(() => {
				const id = formatAddress(addr);
				const existing = qGet.get(id);
				if (existing) {
					if (addr.kind === "app" && defaults) initializeSettings(id, defaults);
					return toConversation(qGet.get(id)!);
				}
				// Fillers — channelOf routes on the prefix, never these columns.
				qInsertConv.run(
					id,
					addr.chatId,
					addr.kind === "topic" ? addr.threadId : null,
					defaultCwd,
					new Date().toISOString(),
				);
				if (addr.kind === "app" && defaults) initializeSettings(id, defaults);
				const created = qGet.get(id);
				if (!created) throw new Error(`conversation ${id} insert failed`);
				return toConversation(created);
			})();
		},

		get(id) {
			const row = qGet.get(id);
			return row ? toConversation(row) : null;
		},

		listGuestConversationIds(chatId) {
			return db
				.query<{ id: string }, [string]>(
					"SELECT id FROM conversations WHERE id LIKE 'guest:' || ? || ':%'",
				)
				.all(String(chatId))
				.map((r) => r.id);
		},

		currentDm(chatId) {
			const roll = qDmRoll.get(chatId);
			if (!roll) return null;
			const row = qGet.get(roll.current_id);
			return row ? toConversation(row) : null;
		},

		rollDm(chatId, defaultCwd) {
			privateChatIdSchema.parse(chatId);
			return db.transaction(() => {
				const roll = qDmRoll.get(chatId);
				const n = (roll?.n ?? 0) + 1;
				const id = formatAddress({ kind: "rolling", chatId, ordinal: n });
				const now = new Date().toISOString();
				const source = roll ? qGet.get(roll.current_id) : null;
				qInsertConv.run(id, chatId, null, defaultCwd, now);
				db.run("UPDATE conversations SET previous_dm_id = ? WHERE id = ?", [
					source && rollingDmOrdinal(source, chatId) !== null ? source.id : null,
					id,
				]);
				qUpsertRoll.run(chatId, id, n, now);
				const created = qGet.get(id);
				if (!created) throw new Error(`conversation ${id} insert failed`);
				return toConversation(created);
			})();
		},

		previousDm(chatId) {
			const row = previousDmRow(chatId);
			return row ? toConversation(row) : null;
		},

		backDm(chatId) {
			return db.transaction(() => {
				const row = previousDmRow(chatId);
				if (!row) return null;
				qSelectPrevious.run(row.id, new Date().toISOString(), chatId);
				return toConversation(row);
			})();
		},

		lastActivityAt(id) {
			const conv = qGet.get(id);
			if (!conv) throw new Error(`conversation ${id} not found`);
			const event = qLastActivity.get(id);
			const roll = qDmRoll.get(conv.chat_id);
			const selectedAt = roll?.current_id === id ? roll.selected_at : null;
			return [conv.created_at, event?.created_at ?? "", selectedAt ?? ""].sort().at(-1)!;
		},

		lastSeq(id) {
			return qNextSeq.get(id)?.n ?? null;
		},

		initializeAppSettings(id, defaults) {
			return db.transaction(() => initializeSettings(id, defaults))();
		},

		forkToApp(fromId, appId, defaultCwd, title, defaults) {
			return db.transaction(() => {
				const id = formatAddress(appAddress(appId));
				qInsertConv.run(id, 0, null, defaultCwd, new Date().toISOString());
				// The memory opt-out is copied state — an excluded DM's text
				// stays unsearchable and unretained in the fork too.
				applyPatch(id, {
					title,
					titleImplicit: true,
					memoryExcluded: qGet.get(fromId)?.memory_excluded === 1,
					...(defaults === undefined ? {} : modelSettingsSchema.parse(defaults)),
				});
				// The FTS triggers fire on these inserts — correct: the app
				// pool's search should see the copied exchange.
				for (const e of qAllEvents.all(fromId)) {
					qInsertEvent.run(
						id,
						e.seq,
						e.role,
						e.data,
						e.anchor_seq,
						e.created_at,
						e.memory_eligible,
					);
				}
				// Only the latest pointer copies — it alone steers the model
				// view — and its eligibility with it: the fork's memory-bound
				// view must match the source's.
				const compaction = qCompaction.get(fromId);
				if (compaction !== null) {
					qInsertCompaction.run(
						id,
						compaction.boundary_seq,
						compaction.summary,
						compaction.summary_eligible,
						compaction.tokens_before,
						compaction.model,
						compaction.created_at,
					);
				}
				for (const c of qContextsFor.all(fromId)) {
					qInsertContext.run(id, c.anchor_seq, c.content, c.source_ids, c.created_at);
				}
				const created = qGet.get(id);
				if (!created) throw new Error(`conversation ${id} insert failed`);
				return toConversation(created);
			})();
		},

		setMeta(id, patch) {
			applyPatch(id, patch);
		},

		bumpEpoch(id) {
			return bump(id);
		},

		promptSnapshot(id) {
			const row = db
				.query<{ text: string; sources: string }, [string]>(
					"SELECT text, sources FROM prompt_snapshots WHERE conversation_id = ?",
				)
				.get(id);
			if (!row) return null;
			let sources: unknown;
			try {
				sources = JSON.parse(row.sources);
			} catch (err) {
				throw new Error(`corrupt prompt snapshot sources: ${id}: ${String(err)}`);
			}
			if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string")) {
				throw new Error(`corrupt prompt snapshot: ${id}`);
			}
			return { text: row.text, sources: sources as string[] };
		},

		savePromptSnapshot(id, text, sources) {
			db.run(
				"INSERT INTO prompt_snapshots (conversation_id, text, sources, built_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET text = excluded.text, sources = excluded.sources, built_at = excluded.built_at",
				[id, text, JSON.stringify(sources), new Date().toISOString()],
			);
		},

		clearPromptSnapshot(id) {
			db.run("DELETE FROM prompt_snapshots WHERE conversation_id = ?", [id]);
		},

		applySettings(id, patch) {
			return db.transaction(() => {
				applyPatch(id, patch);
				return bump(id);
			})();
		},

		append(id, messages, opts) {
			let operation: string | undefined;
			let unarchived = false;
			db.transaction(() => {
				const start = qNextSeq.get(id)?.n ?? 0;
				const now = new Date().toISOString();
				// Eligibility is stamped at admission, from the live exclusion
				// flag — the one moment the answer is knowable (#85). Everything
				// later (including a /memory on) reads this stamp, never the
				// flag: history is not rewritten and exclusion is not retroactive.
				const conv = qGet.get(id);
				if (!conv) throw new Error(`conversation ${id} not found`);
				const eligible = conv.memory_excluded === 0 ? 1 : 0;
				// Activity resurrects: an archived app conversation that
				// receives an event (delegation notice, operator send) comes
				// back to the rail rather than accumulating replies unseen.
				if (
					conv.archived_at !== null &&
					db.run("UPDATE conversations SET archived_at = NULL WHERE id = ?", [id]).changes > 0
				) {
					unarchived = true;
				}
				for (const [i, m] of messages.entries()) {
					qInsertEvent.run(
						id,
						start + i + 1,
						m.role,
						JSON.stringify({ v: 1, message: m }),
						opts?.anchorSeq ?? null,
						now,
						eligible,
					);
				}
				if (opts?.memory) {
					if (
						opts.memory.document.conversationId !== id ||
						!messages.some(
							(message) =>
								message.role === "assistant" &&
								opts.memory!.document.sourceIds.includes(message.id),
						)
					) {
						throw new Error("Memory retention must accompany its completed assistant event");
					}
					operation = memoryQueue.enqueue(opts.memory.target, opts.memory.document);
				}
			})();
			if (operation)
				log.info("memory queued", {
					conversation: id,
					operation,
					document: opts?.memory?.document.id,
				});
			if (unarchived) {
				log.info("conversation unarchived on activity", { conversation: id });
			}
		},

		lastUserSeq(id) {
			return qLastUserSeq.get(id)?.seq ?? null;
		},

		memoryEligibility(id) {
			return {
				eligibleSeqs: new Set(qEligibleSeqs.all(id).map((r) => r.seq)),
				// No compaction = no summary in any view; false keeps the
				// default fail-closed anyway.
				summaryEligible: this.getCompaction(id)?.summaryEligible ?? false,
			};
		},

		searchHistory(query, limit, channelPrefix) {
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
		},

		eventContext(id, seq, window) {
			const w = Math.max(0, Math.min(window, 25));
			const rows: HistoryContextRow[] = [];
			for (const r of qContext.all(id, seq - w, seq + w)) {
				const message = parseEvent(id, r.seq, r.role, r.data);
				if (message === null) continue;
				rows.push({
					seq: r.seq,
					role: r.role,
					text: messageText(message),
					createdAt: r.created_at,
				});
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
					// Titles flatten too; reduced to nothing, they fall through
					// to the preview.
					title: r.title === null ? null : flatLine(r.title) || null,
					createdAt: r.created_at,
					updatedAt: last?.created_at ?? r.created_at,
					preview: message === null ? "" : flatLine(messageText(message)).slice(0, 200),
					archivedAt: r.archived_at,
					activity: last?.id ?? 0,
				});
			}
			out.sort((a, b) => b.activity - a.activity);
			return out.map(({ activity: _activity, ...summary }) => summary);
		},

		deleteConversation(id) {
			// Pending retention rides the outbox's own sweeper — a corrupt
			// payload must not bar the delete, so a failure here is a warn,
			// not a rollback of the conversation rows.
			try {
				memoryQueue.cancelConversation(id);
			} catch (err) {
				log.warn("retention purge failed during conversation delete", err, {
					conversation: id,
				});
			}
			db.transaction(() => {
				qDeleteEvents.run(id);
				qDeleteCompactions.run(id);
				qDeleteContexts.run(id);
				qDeleteConv.run(id);
			})();
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
			// Arrival order stays on disk; this sorts each anchored response
			// right after its user event. Key = anchor ?? seq, tiebreak = seq
			// — an anchor always precedes its own seq.
			rows.sort((a, b) => {
				const ka = a.anchorSeq ?? a.seq;
				const kb = b.anchorSeq ?? b.seq;
				return ka - kb || a.seq - b.seq;
			});
			return rows;
		},

		modelEntries(id) {
			const compaction = this.getCompaction(id);
			// Filter on the causal key: an anchored response to a compacted
			// user event has a high seq but an early causal position — it
			// belongs to the summarized span, not the tail.
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
