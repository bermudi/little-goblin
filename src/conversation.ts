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
import { splitModelRef, thinkingLevels, type Config, type ThinkingLevel } from "./config.ts";
import { MemoryContexts, type MemoryEligibility, messageText } from "./memory.ts";
import { MemoryQueue } from "./memory-queue.ts";
import { compactionSummaryId, corruptRowId } from "./tags.ts";
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
	// Guest mode (design/telegram.md → Guest mode): one conversation per
	// (chat, summoner) — third-party sandboxed turns and the operator's
	// own guest summons. chatId is the summoned chat (negative for
	// groups), userId the summoner (positive).
	| { kind: "guest"; chatId: number; userId: number }
	| { kind: "app"; appId: string; chatId: 0; threadId: 0 };

export const APP_ID_PREFIX = "app/";

// App ids are client-minted but not arbitrary: the id rides the "app/"
// conversation id and an HTTP path segment, so it stays url-safe and
// slash-free (a uuid or nanoid fits). Validated at the codec —
// formatAddress and parseAddress are the only writers and readers of
// the format — so a malformed id can never reach the store.
export const appIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "app ids are [A-Za-z0-9_-], 1-64 chars");

// A rolling conversation id's parts (design/telegram.md → Rolling DM):
// dm:<chat>:<n>, where n is the creation ordinal — a high-water that
// only grows. Not a ConversationAddress member: resolve() must never
// mint one (rollDm owns creation), but the codec parses and formats it
// like every other id shape.
export interface RollingDmAddress {
	kind: "rolling";
	chatId: number;
	ordinal: number;
}

// Every shape a conversation id (or intake lane key) can take — the
// resolve() inputs plus the rolling conversations. parseAddress
// returns it; formatAddress accepts it.
export type ParsedAddress = ConversationAddress | RollingDmAddress;

// The single builder for conversation ids and lane keys. One schema,
// so a malformed address fails here — not silently, downstream.
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

// Safe integer coordinates out of a regex match — null when any
// captured number exceeds what a Number can hold exactly.
function coordsOf(match: RegExpExecArray | null): number[] | null {
	if (match === null) return null;
	const nums = match.slice(1).map(Number);
	return nums.every(Number.isSafeInteger) ? nums : null;
}

// The single parser — parseAddress ∘ formatAddress is the identity on
// every id the store, the inbox, and the lanes hold. Null on anything
// else: callers route on the null (skip, throw, or tombstone), never
// guess. Rolling ordinals decode as [1-9]\d* — rollDm mints them and
// never rewrites them, so a zero or leading-zero ordinal is not an id.
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

// The client-minted id an app/ conversation id carries — the codec's
// projection for the surfaces that need the bare id (the deep link).
// Null on every other channel or a malformed id.
export function appIdOf(conversationId: string): string | null {
	const parsed = parseAddress(conversationId);
	return parsed !== null && parsed.kind === "app" ? parsed.appId : null;
}

// The one well-formed way to build an app address — validated here and
// again in formatAddress so a client-minted id can never smuggle a path
// segment or a slash into the conversation id.
export function appAddress(appId: string): ConversationAddress {
	return { kind: "app", appId: appIdSchema.parse(appId), chatId: 0, threadId: 0 };
}

// The channel a conversation id belongs to — the address is the id, so
// the prefix is the whole discriminant. chat_id/thread_id are only the
// decoded Telegram coordinates; nothing app-side may read them.
// "guest" is its own channel, not a telegram flavor: tool assembly and
// delivery branch on it (no program/mail/delegate/memory/history tools,
// no pinned programs) even though settings still follow Telegram's
// shared selection.
export function channelOf(conversationId: string): "telegram" | "app" | "guest" {
	if (conversationId.startsWith(APP_ID_PREFIX)) return "app";
	if (conversationId.startsWith("guest:")) return "guest";
	return "telegram";
}

// The one well-formed way to build a guest address — same validated-
// constructor rule as appAddress.
export function guestAddress(chatId: number, userId: number): ConversationAddress {
	return { kind: "guest", chatId, userId };
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
	// App conversations own durable model/thinking snapshots. Telegram
	// ignores these columns and uses its one shared config selection.
	model: string | null;
	thinking: string | null;
	voice: boolean;
	memoryExcluded: boolean; // operator opt-out: this topic sends/recalls no memory
	persona: "personal" | "guest"; // prompt class + sandbox tool filter (Guest mode)
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

// Config provider edits must not strand persisted app selections. Check
// every row before initializing anything; a refusal leaves disk untouched.
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
}

// A compaction pointer (DESIGN.md, Compaction). Rows append forever —
// audit trail; the latest per conversation is the active boundary.
// summaryEligible (design/memory.md → exclusions): whether the folded
// span contained only memory-eligible events — the summary is derived
// text, so it may reach memory-bound builders only when every event it
// was distilled from was eligible. Stamped by the store at write time
// (it owns the event stamps); never a caller input.
export interface Compaction {
	boundarySeq: number;
	summary: string;
	summaryEligible: boolean;
	tokensBefore: number;
	model: string;
	createdAt: string;
}

// What a caller writes — summaryEligible is store-computed (the store
// owns the event stamps the derivation reads), so it never appears on
// input.
export type CompactionWrite = Omit<Compaction, "summaryEligible">;

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
	setCompaction(id: string, compaction: CompactionWrite): void;
	// Get-or-create by channel address. New conversations start at epoch 0.
	// The cwd column still exists in the table (NOT NULL, no default —
	// existing DBs need it stamped) but cwd is no longer per-conversation
	// state: tools always run in the deployment workspace. Private DMs
	// route through rolling.ts, never here — the legacy dm:<chat>
	// conversation this resolves to is history, never current.
	resolve(addr: ConversationAddress, defaultCwd: string, defaults?: ModelSettings): Conversation;
	get(id: string): Conversation | null;
	// Rolling DM (design/telegram.md → Rolling DM): the bot DM is a
	// rolling address — dm:<chat>:<n> conversations with one current per
	// chat, the boundary drawn by a quiet gap. currentDm returns the
	// current conversation (null = never rolled); rollDm creates
	// dm:<chat>:<n+1> linked to the selected source, then selects it
	// atomically. n is a creation high-water, never rewound by /back.
	currentDm(chatId: number): Conversation | null;
	rollDm(chatId: number, defaultCwd: string): Conversation;
	// Read-only predecessor candidate, restricted to rolling private
	// DMs in this chat. Legacy DM/topic/app conversations never qualify.
	previousDm(chatId: number): Conversation | null;
	// Atomically select that predecessor and reset the quiet-gap clock.
	// Null means no predecessor and no state change. Caller owns logs,
	// cancellation, and pending-input assignment; no history is replayed.
	backDm(chatId: number): Conversation | null;
	// Latest event/creation timestamp, plus the selection timestamp only
	// when this is the current DM — the quiet-gap clock the roller reads.
	lastActivityAt(id: string): string;
	// Highest event seq written so far — null when the conversation
	// holds none. The spin-off discard compares it against the seq at
	// fork time: a change means operator input arrived and the fork
	// must not be deleted (design/app.md → Spin-off).
	lastSeq(id: string): number | null;
	// Spin-off (design/app.md → Spin-off): copy a conversation's model
	// state into a fresh app conversation, in one transaction — every
	// event (seq/role/data/anchor/created_at verbatim), the latest
	// compaction pointer only, and every memory_contexts row. A copy,
	// never a move: the source is untouched. The memory queue is NOT
	// replayed — copied exchanges are already retained, and re-enqueue
	// would re-process them against a bank that already has them.
	// Nothing logs here — the caller owns the `spin-off` line.
	forkToApp(
		fromId: string,
		appId: string,
		defaultCwd: string,
		title: string,
		defaults?: ModelSettings,
	): Conversation;
	// Initialize missing app settings once, without resetting existing
	// snapshots or fencing a running turn. Missing/non-app ids throw.
	initializeAppSettings(id: string, defaults: ModelSettings): ModelSettings;
	setMeta(id: string, patch: ConversationMetaPatch): void;
	// All guest conversations in a chat — closing the chat's guest
	// access fences their running turns (epoch bumps, Guest mode).
	listGuestConversationIds(chatId: number): string[];
	// Settings changes and cancellation bump the epoch; in-flight turns
	// fence themselves against it.
	bumpEpoch(id: string): number;
	// Frozen system-prompt snapshot (DESIGN.md → Cache stability).
	// Null = none yet (first turn, or cleared by compaction to refresh).
	promptSnapshot(id: string): { text: string; sources: string[] } | null;
	savePromptSnapshot(id: string, text: string, sources: string[]): void;
	// Compaction rewrites history — the prefix busts anyway, so the
	// snapshot rebuilds from current files on the next turn.
	clearPromptSnapshot(id: string): void;
	// Settings patch + epoch bump in one transaction — a settings write
	// that fences in-flight turns must never land half-applied.
	applySettings(id: string, patch: ConversationMetaPatch): number;
	// Append UIMessages in one transaction; seq is assigned here.
	// anchorSeq marks a response with the seq of the user event that
	// triggered its turn — history() uses it for causal ordering.
	append(
		id: string,
		messages: UIMessage[],
		opts?: {
			anchorSeq?: number | null;
			memory?: { target: string; document: MemoryDocument };
		},
	): void;
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
	// Memory eligibility (design/memory.md → exclusions): every event's
	// append-time stamp plus the active compaction summary's derived
	// eligibility — the filter input for memory-bound builders. Re-enabling
	// memory reads this, never the live flag, so excluded-era messages stay
	// out of recall queries and retention documents retroactively (#85).
	memoryEligibility(id: string): MemoryEligibility;
	// Full-text search over user/assistant event text (DESIGN.md, Chat
	// search). Memory-excluded conversations are filtered at query time
	// against the live flag — retroactive. Empty when the query has no
	// searchable terms. Rank-best-first, bounded by limit. channelPrefix
	// (a LIKE pattern like "app/%") scopes the pool — the app surface
	// searches only its own channel (DESIGN.md, disjoint pools).
	searchHistory(query: string, limit: number, channelPrefix?: string): HistoryHit[];
	// Arrival-ordered window around one event — paging context around a
	// search hit. No exclusion check here: the tool checks the live flag
	// before calling, the way search filters it in SQL.
	eventContext(id: string, seq: number, window: number): HistoryContextRow[];
	// The app channel's own pool, most recently active first — the two
	// pools never mix, so the list is filtered on the id prefix, not a
	// flag (DESIGN.md, App channel).
	listAppConversations(): AppConversationSummary[];
	// Drop a conversation and everything it owns: events (the FTS delete
	// trigger keeps the index honest), the compaction audit, recall
	// blocks, and queued retention for its documents. A live turn must be
	// fenced first (runtime.stop) — this only touches the store.
	deleteConversation(id: string): void;
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
	// Prompt class (Guest mode): "personal" (normal persona, SOUL et al.)
	// or "guest" (sandbox persona — no private files in, nothing about
	// the operator out). Frozen at creation; drives the tool filter too.
	persona: string;
	epoch: number;
	created_at: string;
	previous_dm_id: string | null; // internal navigation link, never on the wire
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

// Rows are versioned envelopes {"v":1,"message":…} — the SDK owns the
// part shapes, so every row stamps the format that wrote it (DESIGN.md,
// History). The read is envelope-only (the W2.2 purge killed the
// bare-row fallback): openStore still wraps any straggler bare rows
// once at open, and anything else — corrupt or bare — fails the schema
// below and degrades to a placeholder.
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

// The compacted view's synthetic first message (DESIGN.md, Compaction):
// user role, explicit framing — the model reads carried context, not a
// forged transcript. seq = the boundary, so causal sorting keeps it first.
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

// One flat display line out of message text — the app list's title and
// preview rows are single-line labels, so markdown furniture comes off:
// fences and their language tag, inline-code backticks, link syntax
// (text survives), paired emphasis, and line-lead markers. Without it a
// reply that opens on a code block titles the row "```typescript const
// slug = (s:…".
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

// Parse one event row's envelope — null when the row is unreadable.
// The caller decides: history degrades to a placeholder in position,
// search and context skip the row. Warns either way — a silent skip
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
	if (!convCols.has("persona")) {
		db.run("ALTER TABLE conversations ADD COLUMN persona TEXT NOT NULL DEFAULT 'personal'");
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
	// Memory eligibility is stamped per event at append time — the durable
	// answer to "may this text ever reach the memory service?" (#85,
	// design/memory.md → exclusions). DEFAULT 0 makes every pre-stamp row
	// ineligible: their append-time flag is unreconstructable, and enabling
	// memory must not silently backfill historical messages. New rows are
	// always stamped explicitly by append(); forkToApp copies source stamps.
	if (!eventCols.has("memory_eligible")) {
		db.run("ALTER TABLE events ADD COLUMN memory_eligible INTEGER NOT NULL DEFAULT 0");
		const stamped = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n;
		log.info("event memory eligibility stamped — prior rows historical", {
			events: stamped ?? 0,
		});
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
	// summary_eligible carries the folded span's memory eligibility: a
	// summary is distilled text, so it may feed memory-bound builders only
	// when every event it replaced was eligible. DEFAULT 0 fails legacy
	// rows closed the same way the event stamp does.
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
	// conversation started with, served verbatim every turn — file edits
	// load at conversation boundaries (roll, compaction), never
	// mid-run, so a live conversation's prefix cache is never rewritten
	// underneath it.
	db.run(`
		CREATE TABLE IF NOT EXISTS prompt_snapshots (
			conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
			text TEXT NOT NULL,
			sources TEXT NOT NULL,
			built_at TEXT NOT NULL
		)`);
	// Rolling DM (design/telegram.md → Rolling DM): one current
	// dm:<chat>:<n> conversation per private chat; n only grows, so a
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
	// Legacy rows predate the versioned envelope — wrap them once, in
	// place, before anything reads them this boot (reads are strict;
	// without this a bare row would placeholder-degrade). Only
	// well-formed bare UIMessage objects match (top-level string `id`);
	// corrupt rows are left alone and degrade to placeholders on read.
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
	// Memory-bound filter inputs (#85): the eligible seqs, and the folded
	// span's ineligible count a new compaction pointer must consult.
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
	// forkToApp's copy sources — events verbatim (created_at included,
	// unlike the history view, and the eligibility stamp with it: a copied
	// exchange's admission-time eligibility is part of the exchange), and
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
	// Chat search: FTS rowids join back to events for the addressable
	// hit, conversations for the title and the live exclusion flag.
	// Rank-best-first — FTS5's default rank orders best match first.
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
	// The app channel's own pool — the id prefix is the channel marker.
	const qListApp = db.query<{ id: string; title: string | null; created_at: string }, []>(
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
	// deleteConversation's sweep — children before the row, the FK on
	// events/compactions demands it. The events delete fires the FTS
	// delete trigger per row, so the index stays honest for free.
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
			// The summary is derived text: it may feed memory-bound builders
			// only when every event the pointer folds (causal position ≤
			// boundary — the same key modelEntries cuts on) was eligible. A
			// prior summary's span sits below the new boundary too, so one
			// count covers inherited ineligibility across repeated
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
				// Telegram coordinates are fillers on app rows; channelOf
				// routes on the id prefix, never these legacy columns.
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
				// The memory opt-out is part of the copied state — an
				// excluded DM's text must stay unsearchable and
				// unretained in the app fork too.
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
				// Compaction rows are append-only audit — only the latest
				// pointer steers the model view, so only it copies. The
				// summary's eligibility copies with it: the fork's memory-bound
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
					// Display projection: titles are single-line labels too —
					// a markdown-decked title flattens or, reduced to nothing,
					// falls through to the preview.
					title: r.title === null ? null : flatLine(r.title) || null,
					createdAt: r.created_at,
					updatedAt: last?.created_at ?? r.created_at,
					preview: message === null ? "" : flatLine(messageText(message)).slice(0, 200),
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
