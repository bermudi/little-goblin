// The conversation store's read-only view: every query a consumer can
// issue without mutating a conversation. Consumers that only read type
// against this, never ConversationStore — the compiler then keeps writes
// out of read paths. The write side (append, edits, rolling, delete,
// settings) stays on ConversationStore in conversation.ts.

import type { UIMessage } from "ai";
import type { Compaction, CompactionMark } from "./conversation-events.ts";
import type { HistoryContextRow, HistoryHit } from "./conversation-history.ts";
import type { Row } from "./conversation-queries.ts";
import type { MemoryEligibility } from "./memory/mod.ts";
import type { ModelSettings } from "./conversation-settings.ts";

export interface Conversation {
	id: string;
	// Real only on dm:/topic: — app rows store 0/NULL (legacy NOT NULL
	// columns). channelOf(id) is the routing check, never these.
	chatId: number;
	threadId: number | null;
	title: string | null;
	// Telegram placeholder name — the bot owes it a real one. Cleared by
	// explicit rename or a successful auto-title.
	titleImplicit: boolean;
	// Durable per-conversation selection on app rows only; telegram ignores
	// these columns for its one shared config selection.
	model: string | null;
	thinking: string | null;
	voice: boolean;
	memoryExcluded: boolean; // operator opt-out: this topic sends/recalls no memory
	persona: "personal" | "guest"; // prompt class + sandbox tool filter (Guest mode)
	// Hidden from the app rail, still answerable; any appended event clears it.
	archivedAt: string | null;
	// Floats above the app rail's activity order; survives activity,
	// cleared by archive.
	pinnedAt: string | null;
	// Bound once at creation; app conversations only — every other row
	// stays null forever.
	projectId: string | null;
	epoch: number;
	createdAt: string;
}

export function toConversation(r: Row): Conversation {
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
		pinnedAt: r.pinned_at,
		projectId: r.project_id,
		epoch: r.epoch,
		createdAt: r.created_at,
	};
}

// The app channel's own pool, most recently active first.
export interface AppConversationSummary {
	id: string;
	title: string | null;
	createdAt: string;
	// Newest event's timestamp, else createdAt — the list's ordering key.
	updatedAt: string;
	// Newest event's text, capped; "" when no text parts.
	preview: string;
	// Non-null = archived. A stamp, not a bool, so the client's archived
	// section can sort by when the row was shelved.
	archivedAt: string | null;
	// Non-null = pinned: the row floats above the rail's activity order.
	pinnedAt: string | null;
	// Null = an unscoped chat on the main rail; set = the row lives under
	// its project's page.
	projectId: string | null;
}

export interface ConversationReads {
	getCompaction(id: string): Compaction | null;
	// Every pointer, oldest first — the transcript's fold marks. The
	// latest row is the one getCompaction returns.
	listCompactions(id: string): CompactionMark[];
	get(id: string): Conversation | null;
	// Epoch only — authority checks fence on this per tool call and must
	// not materialize the whole conversation row to read one number.
	epochOf(id: string): number | null;
	// One current dm:<chat>:<n> per private chat. Read-only predecessor
	// navigation; rolling private DMs in this chat only.
	currentDm(chatId: number): Conversation | null;
	previousDm(chatId: number): Conversation | null;
	// Latest event/creation time, plus selected_at when current — the quiet-gap clock.
	lastActivityAt(id: string): string;
	// Highest event seq. The spin-off discard compares it against
	// fork-time seq: a change means operator input arrived.
	lastSeq(id: string): number | null;
	// Resolve a durable event by its message id — the edit/branch routes'
	// handle onto an append-only seq. Null when this conversation never
	// stored that id (a client id, a deleted event, another chat).
	messageEvent(id: string, messageId: string): { seq: number; role: string } | null;
	// The causal view (anchored responses sort right after their user
	// event) as messages; historyEntries adds seqs (recall blocks need
	// positions); historyDetail adds anchors (compaction's cut rule) and
	// append stamps (the app's fold-mark placement).
	history(id: string): UIMessage[];
	historyEntries(id: string): { seq: number; message: UIMessage }[];
	historyDetail(id: string): {
		seq: number;
		anchorSeq: number | null;
		createdAt: string;
		message: UIMessage;
	}[];
	// The causal-last event of one role (same key historyDetail sorts
	// on), read as a single row — for boolean/last-message callers that
	// would otherwise materialize the whole history. Null = none.
	lastEntry(id: string, role: UIMessage["role"]): { seq: number; message: UIMessage } | null;
	// What a turn sees: the causal view cut at the active boundary, the
	// summary prepended, and committed event_projections overlaid on
	// tool results. The cut is on causal position — (anchorSeq ??
	// seq) > boundarySeq — so a late answer to a folded question rides
	// into the summary instead of stranding in the tail.
	modelEntries(id: string): { seq: number; message: UIMessage }[];
	// Committed pruning projections — the overlay input for modelEntries
	// and the pruning scan's dedupe set. Empty for a never-pruned
	// conversation.
	eventProjections(id: string): { seq: number; toolCallId: string; replacement: string }[];
	// Seq of the newest user event — a turn's response anchors to it.
	lastUserSeq(id: string): number | null;
	// Anchor of the newest assistant event — the durable reply identity
	// the rating buttons' callback payload carries. Null when no reply
	// has landed yet.
	lastReplyAnchor(id: string): number | null;
	// Every event's append-time stamp plus the summary's derived
	// eligibility — the filter input for memory-bound builders.
	// Re-enabling memory reads this, never the live flag: excluded-era
	// messages stay out of recall and retention retroactively.
	memoryEligibility(id: string): MemoryEligibility;
	// Full-text search over user/assistant event text. Excluded
	// conversations filter at query time against the live flag —
	// retroactive, unlike the event stamps. channelPrefix is a LIKE
	// pattern ("app/%").
	searchHistory(query: string, limit: number, channelPrefix?: string): HistoryHit[];
	// Arrival-ordered window around one event. No exclusion check here —
	// the tool owns exclusion (with its own-conversation exception).
	eventContext(id: string, seq: number, window: number): HistoryContextRow[];
	// The app channel's own pool, most recently active first.
	listAppConversations(): AppConversationSummary[];
	// Ids bound to one project — the memory-off propagation walks them.
	listProjectConversationIds(projectId: string): string[];
	// All guest conversations in a chat — closing guest access fences
	// their running turns.
	listGuestConversationIds(chatId: number): string[];
	// Frozen system-prompt snapshot; null = none yet (first turn, or cleared by compaction).
	promptSnapshot(id: string): { text: string; sources: string[] } | null;
	// The stored pair with defaults filling gaps — no clamp, no write.
	// Missing/non-app ids throw.
	readAppSettings(id: string, defaults: ModelSettings): ModelSettings;
}
