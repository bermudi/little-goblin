// Durability = WAL + transactions, not the tree's tmp/fsync/rename convention.

import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { z } from "zod";
import { type Config, splitModelRef } from "./config-schema.ts";
import { log } from "./log.ts";
import { stampArrival } from "./message-context.ts";
import { MemoryDestinations } from "./memory/destinations.ts";
import type { MemoryDocument } from "./memory/hindsight.ts";
import { MemoryContexts, type MemoryEligibility, messageText } from "./memory/mod.ts";
import { MemoryQueue } from "./memory/queue.ts";
import {
	appAddress,
	channelOf,
	type ConversationAddress,
	formatAddress,
	privateChatIdSchema,
	rollingDmOrdinal,
} from "./conversation-address.ts";
import {
	type Compaction,
	type CompactionMark,
	type CompactionWrite,
	flatLine,
	parseEvent,
} from "./conversation-events.ts";
import {
	type HistoryContextRow,
	type HistoryHit,
	makeConversationHistory,
} from "./conversation-history.ts";
import { prepareConversationQueries, type Row } from "./conversation-queries.ts";
import { ensureConversationSchema } from "./conversation-schema.ts";
import {
	type ConversationMetaPatch,
	makeConversationSettings,
	type ModelSettings,
	modelSettingsSchema,
} from "./conversation-settings.ts";
import { retargetPruningMarker } from "./pruning-marker.ts";
import { coordinationAnchors } from "./responsibilities.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";
import { sweepConversationWakes } from "./wake-store.ts";
import type { ConversationReads } from "./conversation-read.ts";
import type { AppConversationSummary } from "./conversation-read.ts";

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

// A refused config edit must leave disk untouched — persisted app
// selections can't be stranded by a provider removal.
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

// The observable shape of an edit's sweep: the cut is the edited event's
// seq, seq is the new event's (never-reused) position, and the counts
// name every dependent the delete removed.
export interface MessageEdit {
	seq: number;
	cutSeq: number;
	events: number;
	compactions: number;
	contexts: number;
	projections: number;
	ratings: number;
}

// deleteConversation's designed refusal (coordination anchors), typed so
// a boundary can tell it from a real failure — the app's DELETE route
// must answer it, not 500 it.
export class DeleteRefused extends Error {}

// One text for both surfaces: deleteRefusal's advisory answer and
// deleteConversation's throw must never drift apart.
const deleteRefusalText = (
	id: string,
	anchors: { responsibilityId: string; status: string }[],
): string =>
	`conversation ${id} coordinates ${anchors
		.map((a) => `${a.responsibilityId} (${a.status})`)
		.join(", ")} — resolve them before deleting`;

// The write side plus the shared handles. Every read lives on
// ConversationReads (conversation-read.ts), which this extends —
// consumers that only read type against the reads view.
export interface ConversationStore extends ConversationReads {
	// Shared handle — the memory/outage modules each own tables in this file.
	readonly db: Database;
	readonly memoryQueue: MemoryQueue;
	readonly memoryContexts: MemoryContexts;
	// Boot records the live endpoint+bank so forget can reconstruct a
	// previous bank's client.
	readonly memoryDestinations: MemoryDestinations;
	setCompaction(id: string, compaction: CompactionWrite): void;
	// Get-or-create. Private DMs route through rolling.ts — a legacy
	// dm:<chat> row here is history, never current. (cwd is a legacy
	// NOT NULL column: stamped, ignored.)
	resolve(addr: ConversationAddress, defaultCwd: string, defaults?: ModelSettings): Conversation;
	// One current dm:<chat>:<n> per private chat; rollDm mints n+1 linked
	// to the selected source, selected atomically. n is a creation
	// high-water, never rewound by /back.
	rollDm(chatId: number, defaultCwd: string): Conversation;
	// Atomically select the predecessor and reset the quiet-gap clock;
	// null = no state change. No history replays; the caller owns logs
	// and pending input.
	backDm(chatId: number): Conversation | null;
	// Spin-off/branch: copy model state into a fresh app conversation, one
	// transaction — every event verbatim, the latest compaction pointer,
	// every memory_contexts row. The memory queue is NOT replayed (copies
	// are already retained); the caller owns the `spin-off`/`branched` log
	// line. throughSeq cuts a branch at a causal position (a branch never
	// rewrites the source); projectId is the binding branch copies from
	// the source, fixed at creation like every other app conversation.
	forkToApp(
		fromId: string,
		appId: string,
		defaultCwd: string,
		title: string | null,
		defaults?: ModelSettings,
		opts?: {
			throughSeq?: number;
			projectId?: string | null;
			// A branch copies a real title; a spin-off's provisional name
			// stays implicit so the retitle path can improve it.
			titleImplicit?: boolean;
		},
	): Conversation;
	// Edit a user message: drop it and every causally later event in one
	// transaction, sweep their compaction/recall/projection/rating
	// dependents, then append the edited message at a seq no event has
	// ever used. The epoch advances with the rewind — pre-edit wake
	// claims fail closed instead of resubmitting dead seqs — and the
	// captured context window drops with the content it described. One
	// transaction, so an interrupted write cannot leave a hole where the
	// transcript was. Null when the id is not a user event of this
	// conversation; the caller fences live work and owns the log line.
	// Queued retention for the dropped tail is cancelled after the
	// commit (an already-retained memory is not recalled here).
	editUserMessage(id: string, messageId: string, message: UIMessage): MessageEdit | null;
	// Initialize missing app settings once, no reset, no epoch fence;
	// missing/non-app ids throw.
	initializeAppSettings(
		id: string,
		defaults: ModelSettings & { providers?: Config["providers"] },
	): ModelSettings;
	setMeta(id: string, patch: ConversationMetaPatch): void;
	// Settings changes and cancellation bump the epoch; in-flight turns
	// fence on it. A recreated address must advance past its deleted row.
	bumpEpoch(id: string, previousEpoch?: number): number;
	savePromptSnapshot(id: string, text: string, sources: string[]): void;
	// Compaction busts the prompt prefix anyway — the snapshot rebuilds
	// from current files on the next turn.
	clearPromptSnapshot(id: string): void;
	// Settings patch + epoch bump in one transaction — never half-applied.
	applySettings(id: string, patch: ConversationMetaPatch): number;
	// One transaction; seq assigned here and returned (one per message,
	// in order) — callers that journal the event need the real seq, not
	// a lastUserSeq inference. anchorSeq ties a response to the user
	// event that triggered its turn.
	append(
		id: string,
		messages: UIMessage[],
		opts?: {
			anchorSeq?: number | null;
			memory?: { target: string; document: MemoryDocument };
			// Force the ineligible stamp even when the live flag is on:
			// a reply that derived from an excluded-era input stays out
			// of every memory-bound projection, same as excluded-era
			// events themselves.
			exclude?: boolean;
		},
	): number[];
	// INSERT OR IGNORE in one transaction, so a re-scan can never rewrite
	// a committed row. Returns the number of rows actually inserted.
	applyEventProjections(
		id: string,
		rows: {
			seq: number;
			toolCallId: string;
			replacement: string;
			routeKey: string;
			settingsHash: string;
		}[],
	): number;
	// The one write to project_id — creation only. A row already bound
	// to a different project refuses; rebinding the same id is a no-op.
	bindProject(id: string, projectId: string): void;
	// The refusal deleteConversation would raise right now, as the message
	// the caller should show — null when the delete would proceed.
	// Advisory, not a fence: an anchor minted after this answer (a live
	// turn taking a responsibility) still refuses inside deleteConversation.
	deleteRefusal(id: string): string | null;
	// Drop a conversation and everything it owns (events fire the FTS
	// delete trigger). A live turn must be fenced first (runtime.stop) —
	// this only touches the store. The anchor refusal is DeleteRefused.
	deleteConversation(id: string): void;
	close(): void;
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
		pinnedAt: r.pinned_at,
		projectId: r.project_id,
		epoch: r.epoch,
		createdAt: r.created_at,
	};
}

export function openStore(dbPath: string): ConversationStore {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	// Telegram acks after the inbox insert: WAL/NORMAL survives a crash,
	// but host power loss could discard an acked commit — FULL syncs
	// before we return.
	db.run("PRAGMA synchronous = FULL");
	// No default busy handler: an operator's sqlite3 session or a
	// checkpoint holding the write lock would fail the next insert on the
	// spot — the inbox insert that precedes the Telegram ack included. The
	// wait is bounded short: connections in this one thread share the
	// file, so a nested cross-connection write (a bug) must still surface
	// within seconds, not wedge the event loop.
	db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	db.run("PRAGMA foreign_keys = ON");
	ensureConversationSchema(db);
	const memoryQueue = new MemoryQueue(db);
	const memoryContexts = new MemoryContexts(db);
	const memoryDestinations = new MemoryDestinations(db);
	const {
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
	} = prepareConversationQueries(db);

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

	const { applyPatch, readSettings, initializeSettings, bump } = makeConversationSettings(
		db,
		qGet,
		qEpoch,
	);

	function getCompaction(id: string): Compaction | null {
		const row = qCompaction.get(id);
		return row
			? {
					boundarySeq: row.boundary_seq,
					summary: row.summary,
					summaryEligible: row.summary_eligible !== 0,
					tokensBefore: row.tokens_before,
					model: row.model,
					createdAt: row.created_at,
					tailEvents: row.tail_events,
				}
			: null;
	}

	function listCompactions(id: string): CompactionMark[] {
		return qCompactions.all(id).map((row) => ({
			boundarySeq: row.boundary_seq,
			summary: row.summary,
			tokensBefore: row.tokens_before,
			tailEvents: row.tail_events,
			model: row.model,
			createdAt: row.created_at,
		}));
	}

	const historyView = makeConversationHistory(
		db,
		{ qHistory, qHistoryCausal, qLastByRole, qProjections, qInsertProjection, qSearch, qContext },
		getCompaction,
	);

	return {
		db,
		memoryQueue,
		memoryContexts,
		memoryDestinations,
		...historyView,

		getCompaction,

		listCompactions,

		setCompaction(id, compaction) {
			// Derived text feeds memory-bound builders only when every event
			// the pointer folds (causal position ≤ boundary — the key
			// modelEntries cuts on) was eligible; a prior summary's span sits
			// below the new boundary, so one count covers repeated
			// compactions.
			const foldedIneligible = qIneligibleFolded.get(id, compaction.boundarySeq)?.n ?? 0;
			qInsertCompaction.run(
				id,
				compaction.boundarySeq,
				compaction.summary,
				foldedIneligible === 0 ? 1 : 0,
				compaction.tokensBefore,
				compaction.model,
				compaction.createdAt,
				compaction.tailEvents ?? null,
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

		epochOf(id) {
			return qEpoch.get(id)?.epoch ?? null;
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
				const highwater = qDmRollHighwater.get(chatId);
				let n = Math.max(roll?.n ?? 0, highwater?.n ?? 0) + 1;
				if (!roll) {
					// The lane pointer was severed (its current row deleted)
					// and the stored n went with it — recover the mark from
					// extant rows and the delete tombstones too:
					// dm_roll_highwater only knows what post-upgrade writes
					// told it, and a re-minted ordinal would collide with
					// outstanding epoch tokens and silently reconnect a
					// demoted lane.
					for (const { id: candidate } of qDmOrdinalCandidates.all(chatId, String(chatId))) {
						const ordinal = rollingDmOrdinal(
							{ id: candidate, chat_id: chatId, thread_id: null },
							chatId,
						);
						if (ordinal !== null && ordinal + 1 > n) n = ordinal + 1;
					}
				}
				const id = formatAddress({ kind: "rolling", chatId, ordinal: n });
				const now = new Date().toISOString();
				const source = roll ? qGet.get(roll.current_id) : null;
				qInsertConv.run(id, chatId, null, defaultCwd, now);
				db.run("UPDATE conversations SET previous_dm_id = ? WHERE id = ?", [
					source && rollingDmOrdinal(source, chatId) !== null ? source.id : null,
					id,
				]);
				qUpsertRoll.run(chatId, id, n, now);
				db.run(
					"INSERT INTO dm_roll_highwater (chat_id, n) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET n = excluded.n",
					[chatId, n],
				);
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
			// The highest extant event seq, null when none exists. The
			// spin-off discard treats null as "nothing written yet"; the
			// append high-water mark is not an event.
			return qLastEventSeq.get(id)?.seq ?? null;
		},

		initializeAppSettings(id, defaults) {
			return db.transaction(() => initializeSettings(id, defaults))();
		},

		readAppSettings(id, defaults) {
			return readSettings(id, defaults);
		},

		forkToApp(fromId, appId, defaultCwd, title, defaults, opts) {
			return db.transaction(() => {
				const id = formatAddress(appAddress(appId));
				const through = opts?.throughSeq;
				qInsertConv.run(id, 0, null, defaultCwd, new Date().toISOString());
				// The memory opt-out is copied state — an excluded DM's text
				// stays unsearchable and unretained in the fork too.
				applyPatch(id, {
					...(title === null ? {} : { title }),
					titleImplicit: title === null ? true : (opts?.titleImplicit ?? true),
					memoryExcluded: qGet.get(fromId)?.memory_excluded === 1,
					...(defaults === undefined ? {} : modelSettingsSchema.parse(defaults)),
				});
				if (opts?.projectId !== undefined && opts.projectId !== null) {
					const bound = db.run("UPDATE conversations SET project_id = ? WHERE id = ?", [
						opts.projectId,
						id,
					]);
					if (bound.changes !== 1) throw new Error(`conversation ${id} project bind failed`);
				}
				// The FTS triggers fire on these inserts — correct: the app
				// pool's search should see the copied exchange.
				const events =
					through === undefined ? qAllEvents.all(fromId) : qEventsThrough.all(fromId, through);
				for (const e of events) {
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
				// view must match the source's. A branch drops a pointer whose
				// boundary lies past its cut: the summary would describe events
				// the branch does not hold. Equality keeps it — the pointer
				// folds the inclusive prefix (causal position ≤ boundary),
				// which is exactly what the branch holds at that cut.
				const compaction = qCompaction.get(fromId);
				if (compaction !== null && (through === undefined || compaction.boundary_seq <= through)) {
					qInsertCompaction.run(
						id,
						compaction.boundary_seq,
						compaction.summary,
						compaction.summary_eligible,
						compaction.tokens_before,
						compaction.model,
						compaction.created_at,
						compaction.tail_events,
					);
				}
				for (const c of through === undefined
					? qContextsFor.all(fromId)
					: qContextsThrough.all(fromId, through)) {
					qInsertContext.run(id, c.anchor_seq, c.content, c.source_ids, c.created_at);
				}
				// Committed projections ride along — the fork's model view
				// replays the same markers, and the events they overlay came
				// through the copy above untouched. One rewrite: the marker's
				// recovery address names the source id, so point it at the
				// fork or recovery would read another conversation's events
				// (refused for an excluded fork) and die with the source.
				const projections =
					through === undefined
						? qAllProjections.all(fromId)
						: qProjectionsThrough.all(fromId, through);
				for (const p of projections) {
					qInsertProjection.run(
						id,
						p.seq,
						p.tool_call_id,
						retargetPruningMarker(p.replacement, p.seq, p.tool_call_id, fromId, id),
						p.route_key,
						p.settings_hash,
						p.created_at,
					);
				}
				const created = qGet.get(id);
				if (!created) throw new Error(`conversation ${id} insert failed`);
				return toConversation(created);
			})();
		},

		editUserMessage(id, messageId, message) {
			let unarchived = false;
			const edit = db.transaction((): MessageEdit | null => {
				const found = historyView.messageEvent(id, messageId);
				if (found === null || found.role !== "user") return null;
				const conv = qGet.get(id);
				if (!conv) throw new Error(`conversation ${id} not found`);
				const cut = found.seq;
				// Spend every seq this conversation ever wrote before the
				// delete: a rating or journal row addressed past the cut must
				// never re-bind to the event the edit appends.
				qRaiseSeqHighwater.run(id);
				// The projection sweep reads the events it matches — it runs
				// before the event delete empties them.
				const projections = Number(qRewindProjections.run(id, cut).changes);
				const events = Number(qRewindEvents.run(id, cut).changes);
				const compactions = Number(qRewindCompactions.run(id, cut).changes);
				const contexts = Number(qRewindContexts.run(id, cut).changes);
				const ratings = Number(qRewindRatings.run(id, cut).changes);
				const seq = (qNextSeq.get(id)?.n ?? 0) + 1;
				stampArrival(id, message, new Date());
				qInsertEvent.run(
					id,
					seq,
					message.role,
					JSON.stringify({ v: 1, message }),
					null,
					new Date().toISOString(),
					conv.memory_excluded === 0 ? 1 : 0,
				);
				// The rewind retires every pre-edit admission's authority: a
				// claimed-but-unlinked wake (crash/backoff window) carries a
				// history_seq the delete just killed, and reconcile resubmits
				// such claims only while the claim epoch still matches — the
				// bump fails them closed, never resubmitting a dead seq.
				// Pending wakes are untouched: their delivery is still owed
				// and lands at the new tail under the new epoch; linked wakes
				// keep their run-chain settlement (the edit route abandons
				// interrupted runs the cut orphans).
				bump(id);
				// The captured outbound prompt is verbatim pre-edit content —
				// the window view must not serve it after the rewind. Same
				// sweep deleteConversation runs; the next turn's capture
				// rewrites the row. The native session records go too: the
				// SDK transcript still holds the retracted content.
				qDeleteWindows.run(id);
				qDeleteClaudeSessions.run(id);
				if (
					conv.archived_at !== null &&
					db.run("UPDATE conversations SET archived_at = NULL WHERE id = ?", [id]).changes > 0
				) {
					unarchived = true;
				}
				return { seq, cutSeq: cut, events, compactions, contexts, projections, ratings };
			})();
			if (edit === null) return null;
			// Queued retention follows the events out. The purge waits for
			// the commit — cancelling first and then rolling back would
			// strand rows forever — and an already-retained memory is out of
			// scope: the service owns it, this store can only stop new work.
			try {
				const purged = memoryQueue.cancelAnchoredFrom(id, edit.cutSeq);
				if (purged > 0) {
					log.info("retention purged with edited tail", {
						conversation: id,
						documents: purged,
					});
				}
			} catch (err) {
				log.warn("retention purge failed during message edit", err, { conversation: id });
			}
			if (unarchived) log.info("conversation unarchived on activity", { conversation: id });
			return edit;
		},

		setMeta(id, patch) {
			applyPatch(id, patch);
		},

		bumpEpoch(id, previousEpoch) {
			return bump(id, previousEpoch);
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
			const seqs = db.transaction(() => {
				const start = qNextSeq.get(id)?.n ?? 0;
				const now = new Date().toISOString();
				// Eligibility is stamped at admission, from the live exclusion
				// flag — the one moment the answer is knowable. Everything
				// later (including a /memory on) reads this stamp, never the
				// flag: history is not rewritten and exclusion is not retroactive.
				const conv = qGet.get(id);
				if (!conv) throw new Error(`conversation ${id} not found`);
				const eligible = conv.memory_excluded === 0 && opts?.exclude !== true ? 1 : 0;
				// Activity resurrects an archived app conversation — an
				// event (delegation notice, operator send) returns it to the
				// rail rather than accumulating replies unseen.
				if (
					conv.archived_at !== null &&
					db.run("UPDATE conversations SET archived_at = NULL WHERE id = ?", [id]).changes > 0
				) {
					unarchived = true;
				}
				for (const [i, m] of messages.entries()) {
					stampArrival(id, m, new Date(now));
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
				// The retention gate rides the same transaction as the stamp: an
				// exclusion committed anywhere before this append drops the
				// enqueue here even when the caller computed its option earlier.
				if (opts?.memory && eligible === 1) {
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
				return messages.map((_, i) => start + i + 1);
			})();
			if (operation)
				log.info("memory queued", {
					conversation: id,
					operation,
					document: opts?.memory?.document.id,
				});
			if (opts?.memory && operation === undefined) {
				log.info("memory retention dropped — conversation excluded at write", {
					conversation: id,
					document: opts.memory.document.id,
				});
			}
			if (unarchived) {
				log.info("conversation unarchived on activity", { conversation: id });
			}
			return seqs;
		},

		lastUserSeq(id) {
			return qLastUserSeq.get(id)?.seq ?? null;
		},

		lastReplyAnchor(id) {
			return qLastReplyAnchor.get(id)?.anchor_seq ?? null;
		},

		memoryEligibility(id) {
			const compaction = this.getCompaction(id);
			return {
				eligibleSeqs: new Set(qEligibleSeqs.all(id).map((r) => r.seq)),
				// The summary is the model view's entry at the boundary seq —
				// store-assigned, so classification by seq cannot be forged
				// through a client-chosen message id (#206).
				summarySeq: compaction?.boundarySeq ?? null,
				// No compaction = no summary in any view; false keeps the
				// default fail-closed anyway.
				summaryEligible: compaction?.summaryEligible ?? false,
			};
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
					pinnedAt: r.pinned_at,
					projectId: r.project_id,
					activity: last?.id ?? 0,
				});
			}
			// Timestamp first: an eventless conversation (just created, no
			// message yet) has activity 0 and would sink to the bottom of the
			// rail until its first event, then jump to the top. Event id
			// breaks same-instant ties.
			out.sort(
				(a, b) =>
					Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.activity - a.activity,
			);
			// Pins float above the activity stream; within each group the
			// activity order stands. applyPatch clears the pin on archive,
			// so a pinned row is always on the active rail.
			const pinned = out.filter((r) => r.pinnedAt !== null);
			return [...pinned, ...out.filter((r) => r.pinnedAt === null)].map(
				({ activity: _activity, ...summary }) => summary,
			);
		},

		bindProject(id, projectId) {
			const row = qGet.get(id);
			if (row === null) throw new Error(`conversation ${id} not found`);
			if (row.project_id !== null && row.project_id !== projectId) {
				throw new Error(`conversation ${id} is already bound to project ${row.project_id}`);
			}
			db.run("UPDATE conversations SET project_id = ? WHERE id = ?", [projectId, id]);
		},

		listProjectConversationIds(projectId) {
			return qProjectConvs.all(projectId).map((r) => r.id);
		},

		deleteRefusal(id) {
			const anchors = coordinationAnchors(db, id);
			return anchors.length > 0 ? deleteRefusalText(id, anchors) : null;
		},

		deleteConversation(id) {
			const swept = db.transaction((): { wakes: number; workEvents: number } => {
				// A coordination surface must not outlive the responsibility
				// that stands on it: the handover loop and wake delivery
				// would both dangle. Terminal responsibilities keep their
				// records — the conversation stays too. Refuse with names,
				// not the bare FK error the row delete would raise.
				const anchors = coordinationAnchors(db, id);
				if (anchors.length > 0) {
					throw new DeleteRefused(deleteRefusalText(id, anchors));
				}
				// Sever the rolling navigation chain first — successors'
				// previous_dm_id would FK-fail the row delete (a demoted
				// lane's persona reset is the one caller that deletes a
				// rolled conversation; /back must not reach it anyway).
				db.run("UPDATE conversations SET previous_dm_id = NULL WHERE previous_dm_id = ?", [id]);
				// Preserve the lane's rolling ordinal high-water before
				// dropping the FK-enforced dm_rolls row, so a demoted lane
				// re-mints a fresh id instead of colliding with (or reusing)
				// the deleted conversation.
				db.run(
					`INSERT INTO dm_roll_highwater (chat_id, n)
					SELECT chat_id, n FROM dm_rolls WHERE current_id = ?
					ON CONFLICT(chat_id) DO UPDATE SET
						n = MAX(dm_roll_highwater.n, excluded.n)`,
					[id],
				);
				// The lane pointer is NOT NULL — dropping the deleted row's
				// dm_rolls entry is the sever; the high-water survives in
				// dm_roll_highwater and rollDm re-mints the lane (the reset
				// flow calls it immediately).
				db.run("DELETE FROM dm_rolls WHERE current_id = ?", [id]);
				// Record the final epoch before the row goes — a recreated id
				// must not collide with a token this generation issued.
				const gone = qGet.get(id);
				if (gone !== null) {
					db.run(
						`INSERT INTO conversation_epoch_hwm (conversation_id, epoch) VALUES (?, ?)
						 ON CONFLICT(conversation_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)`,
						[gone.id, gone.epoch],
					);
				}
				// Wake rows are this conversation's delivery bookkeeping —
				// they ride the delete, in the same transaction.
				const counts = sweepConversationWakes(db, id);
				qDeleteEvents.run(id);
				qDeleteCompactions.run(id);
				qDeleteContexts.run(id);
				// The captured window has no FK — it rides the sweep so a
				// re-minted id never inherits the last generation's prompt.
				// Same for the native session records (#418).
				qDeleteWindows.run(id);
				qDeleteClaudeSessions.run(id);
				qDeleteConv.run(id);
				return counts;
			})();
			if (swept.wakes > 0) {
				log.info("wake rows swept with conversation", {
					conversation: id,
					wakes: swept.wakes,
					workEvents: swept.workEvents,
				});
			}
			// The purge waits for the commit: queued retention rides the
			// append transaction only, so cancelling before the delete and
			// then rolling back would strand those rows forever. A purge
			// failure is still a warn — a corrupt payload must not bar the
			// delete that already landed.
			try {
				memoryQueue.cancelConversation(id);
			} catch (err) {
				log.warn("retention purge failed during conversation delete", err, {
					conversation: id,
				});
			}
		},

		close() {
			db.close();
		},
	};
}
