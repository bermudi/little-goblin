// Durability = WAL + transactions, not the tree's tmp/fsync/rename convention.

import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { z } from "zod";
import { type Config, splitModelRef } from "./config-schema.ts";
import { log } from "./log.ts";
import { MemoryDestinations } from "./memory/destinations.ts";
import type { MemoryDocument } from "./memory/hindsight.ts";
import { MemoryContexts, type MemoryEligibility, messageText } from "./memory/mod.ts";
import { MemoryQueue } from "./memory/queue.ts";
import { channelOf, type ConversationAddress, formatAddress } from "./conversation-address.ts";
import { type CompactionWrite, flatLine, parseEvent } from "./conversation-events.ts";
import {
	type HistoryContextRow,
	type HistoryHit,
	makeConversationHistory,
} from "./conversation-history.ts";
import { makeConversationCompaction } from "./conversation-compaction.ts";
import { makeConversationFork } from "./conversation-fork.ts";
import { makeConversationRolling } from "./conversation-rolling.ts";
import { type MessageEdit, makeConversationTranscript } from "./conversation-transcript.ts";
import { prepareConversationQueries, type Row } from "./conversation-queries.ts";
import { ensureConversationSchema } from "./conversation-schema.ts";
import {
	type ConversationMetaPatch,
	makeConversationSettings,
	type ModelSettings,
} from "./conversation-settings.ts";
import { coordinationAnchors } from "./responsibilities.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";
import { sweepConversationWakes } from "./wake-store.ts";
import {
	type AppConversationSummary,
	type Conversation,
	type ConversationReads,
	toConversation,
} from "./conversation-read.ts";

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
	const queries = prepareConversationQueries(db);
	const {
		qGet,
		qInsertConv,
		qDmRoll,
		qLastActivity,
		qHistory,
		qHistoryCausal,
		qLastByRole,
		qLastEventSeq,
		qLastUserSeq,
		qLastReplyAnchor,
		qEligibleSeqs,
		qProjections,
		qInsertProjection,
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
	} = queries;

	const rolling = makeConversationRolling(db, queries);

	const { applyPatch, readSettings, initializeSettings, bump } = makeConversationSettings(
		db,
		qGet,
		qEpoch,
	);

	const compaction = makeConversationCompaction(queries);

	const fork = makeConversationFork(db, queries, applyPatch);

	const historyView = makeConversationHistory(
		db,
		{ qHistory, qHistoryCausal, qLastByRole, qProjections, qInsertProjection, qSearch, qContext },
		compaction.getCompaction,
	);

	const transcript = makeConversationTranscript(db, queries, {
		memoryQueue,
		bump,
		messageEvent: historyView.messageEvent,
	});

	return {
		db,
		memoryQueue,
		memoryContexts,
		memoryDestinations,
		...historyView,

		...compaction,

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

		...rolling,

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

		...fork,

		...transcript,

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
