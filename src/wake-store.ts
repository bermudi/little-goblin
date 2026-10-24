// Durable wake store: work events and their wake deliveries on the
// conversation store's shared SQLite handle, so the trigger append, its
// history reference, and the delivery state commit together. One pending
// wake per coordination conversation coalesces developments without
// losing their event IDs; the trigger message is appended exactly once
// (commit is append + stamp in one transaction). A claimed wake is owned
// by the journal run that processes it — a submit or onDone callback is
// not the acknowledgement, the run's terminal state is. reconcile()
// only classifies against run state; execution (append, submit, settle)
// is the dispatcher's job, never this module's.

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import type { JournalStatus } from "./turn-journal.ts";

export type WakeState = "pending" | "claimed" | "settled" | "failed";

export interface DevelopmentInput {
	/** Caller-defined stable identity: a duplicate poll or a repeated
	 *  scheduled delivery reuses the key and cannot create a new event. */
	sourceKey: string;
	conversationId: string;
	kind: string;
	/** The development's one line in the composed trigger message. */
	text: string;
	/** Opaque JSON — observed facts and evidence references. */
	facts: unknown;
	origin: string;
	/** The project responsibility this development belongs to, when it
	 *  carries one — the feed joins on it, delivery doesn't care. */
	responsibilityId?: string;
	/** Occurrence replay (the scheduler's crash recovery): the same
	 *  source key may re-record with fresher mutable state in the text —
	 *  a correction or attachment change between the original record and
	 *  the lost cursor write. Reuse the recorded event instead of
	 *  refusing; the occurrence that fired is the one that delivers.
	 *  Conversation and kind are still identity: drift there is
	 *  corruption and throws regardless. */
	replay?: boolean;
}

export interface WakeRecord {
	wakeId: number;
	conversationId: string;
	/** Stable trigger-message identity — the same across any retry. */
	messageId: string;
	state: WakeState;
	/** events.seq of the appended trigger — the durable history reference. */
	historySeq: number | null;
	/** Authority at append time; an unlinked claim cannot outlive it. */
	claimEpoch: number | null;
	runId: string | null;
	attempts: number;
	lastError: string | null;
	nextAttemptAt: string | null;
	createdAt: string;
	claimedAt: string | null;
	settledAt: string | null;
	/** Composed trigger text — the wake's events in id order. */
	text: string;
	events: { eventId: number; sourceKey: string }[];
}

export interface ReconcilePlan {
	/** Never appended — append, then submit through submitPersisted(). */
	toAppend: WakeRecord[];
	/** Appended, no run began — retry submitPersisted() only; the
	 *  trigger message must never be appended a second time. */
	toResubmit: WakeRecord[];
	/** Retry backoff has not elapsed — leave alone this pass. */
	waitingBackoff: WakeRecord[];
	/** The journal run completed — settle the disposition. */
	toSettle: WakeRecord[];
	/** The journal run ended error/fenced/abandoned — fail the disposition. */
	toFail: WakeRecord[];
	/** Interrupted or live runs — the resume machinery owns them; never
	 *  resubmitted as a fresh assignment. */
	preserved: WakeRecord[];
}

const wakeRowSchema = z.object({
	wake_id: z.number(),
	conversation_id: z.string(),
	message_id: z.string(),
	state: z.enum(["pending", "claimed", "settled", "failed"]),
	history_seq: z.number().nullable(),
	claim_epoch: z.number().nullable(),
	run_id: z.string().nullable(),
	attempts: z.number(),
	last_error: z.string().nullable(),
	next_attempt_at: z.string().nullable(),
	created_at: z.string(),
	claimed_at: z.string().nullable(),
	settled_at: z.string().nullable(),
});
type WakeRow = z.infer<typeof wakeRowSchema>;

const eventRefSchema = z.object({
	event_id: z.number(),
	source_key: z.string(),
	text: z.string(),
});

// The appended event's data envelope, as conversation.ts writes it.
const appendedEventSchema = z.object({
	v: z.number(),
	message: z.object({ id: z.string() }),
});

const eventIdentitySchema = z.object({
	event_id: z.number(),
	conversation_id: z.string(),
	kind: z.string(),
	text: z.string(),
});

export interface WakeStore {
	/** Record one development; a duplicate source key is a no-op that
	 *  returns the existing event. Joins the conversation's pending wake
	 *  or opens one — all in one transaction. */
	record(input: DevelopmentInput): { eventId: number; wakeId: number; created: boolean };
	get(wakeId: number): WakeRecord | null;
	/** Pending wakes, oldest first (optionally one conversation's). */
	pending(conversationId?: string): WakeRecord[];
	/** Wakes linked to a journal run. */
	forRun(runId: string): WakeRecord[];
	/** Claimed wakes in one conversation whose trigger's durable event
	 *  seq is in the set — the run membership lookup the dispatcher's
	 *  link hooks use. Seq-scoped, never message-id-scoped: client ids
	 *  may repeat across events and conversations. */
	claimedForEvents(conversationId: string, eventSeqs: number[]): WakeRecord[];
	/** The atomic append: compose the trigger, run `append` in the same
	 *  transaction, verify it landed, stamp its seq, claim the wake.
	 *  A wake past pending is returned unchanged, never appended twice. */
	commit(wakeId: number, append: (trigger: { id: string; text: string }) => void): WakeRecord;
	/** The run that will process this wake — called before model/tool
	 *  execution. Idempotent for the same run. */
	linkRun(wakeId: number, runId: string): void;
	/** A resume admission moves the link from the interrupted run to its
	 *  successor. */
	retargetRun(wakeId: number, fromRunId: string, toRunId: string): void;
	settle(wakeId: number, outcome: "settled" | "failed", opts?: { error?: string }): void;
	/** Terminal failure for a pending wake whose conversation row is
	 *  gone — out-of-band corruption only; the FK chain and
	 *  deleteConversation's sweep keep the two together. Claims without
	 *  an append: no history exists to reference, so the seq is a
	 *  sentinel and the claim epoch stays NULL (no provable authority),
	 *  then settles failed — one transaction, the same terminal tomb
	 *  settle produces from claimed. */
	failOrphan(wakeId: number, error: string): void;
	/** Terminal fail-closed for a claimed wake whose ownership link
	 *  could not be persisted: the trigger's run executes regardless
	 *  (hooks never gate a turn), so the only safe disposition is
	 *  terminal — reconcile must never read the claim as unowned and
	 *  resubmit a trigger that already ran. CAS: only an unlinked claim
	 *  closes; a wake linked meanwhile (or already terminal) stands and
	 *  false returns. */
	failUnlinked(wakeId: number, error: string): boolean;
	/** Transient pre-execution failure: attempt count, error, next gate. */
	noteFailure(wakeId: number, error: string, nextAttemptAt: string | null): void;
	/** Boot classification against history and journal — reads only. */
	reconcile(now: string, runStatus: (runId: string) => JournalStatus | null): ReconcilePlan;
}

// Driven by openStore alongside the other companion schemas — the FK
// chain from wake rows to conversations and deleteConversation's sweep
// need the tables present on every conversation-store handle, not only
// ones where the dispatcher was wired. openWakeStore re-ensures for
// standalone opens; both are idempotent.
export function ensureWakeSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS work_events (
			event_id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_key TEXT NOT NULL UNIQUE,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			kind TEXT NOT NULL,
			text TEXT NOT NULL,
			facts_json TEXT NOT NULL,
			origin TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`);
	// Same migrate-on-open pattern as turn-journal: CREATE covers a
	// fresh database, ALTER fills an existing one. responsibility_id is
	// a feed/observer join key — delivery never reads it.
	const eventCols = new Set(
		(db.query("PRAGMA table_info(work_events)").all() as { name: string }[]).map((c) => c.name),
	);
	if (!eventCols.has("responsibility_id")) {
		db.exec("ALTER TABLE work_events ADD COLUMN responsibility_id TEXT");
	}
	db.run(`
		CREATE TABLE IF NOT EXISTS wake_deliveries (
			wake_id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			message_id TEXT NOT NULL UNIQUE,
			state TEXT NOT NULL CHECK (state IN ('pending','claimed','settled','failed')),
			history_seq INTEGER,
			claim_epoch INTEGER,
			run_id TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			next_attempt_at TEXT,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			settled_at TEXT,
			CHECK ((state = 'pending' AND history_seq IS NULL AND claimed_at IS NULL)
				OR (state <> 'pending' AND history_seq IS NOT NULL AND claimed_at IS NOT NULL))
		)`);
	const wakeCols = db.query<{ name: string }, []>("PRAGMA table_info(wake_deliveries)").all();
	if (!wakeCols.some((c) => c.name === "claim_epoch")) {
		// Old unlinked claims have no provable authority. Leave them NULL
		// so reconciliation fails closed rather than reviving stopped work.
		db.run("ALTER TABLE wake_deliveries ADD COLUMN claim_epoch INTEGER");
		log.info("wake claim authority column added — legacy unlinked claims fail closed");
	}
	db.run(`
		CREATE TABLE IF NOT EXISTS wake_events (
			wake_id INTEGER NOT NULL REFERENCES wake_deliveries(wake_id),
			event_id INTEGER NOT NULL REFERENCES work_events(event_id),
			PRIMARY KEY (wake_id, event_id)
		)`);
	db.run(
		"CREATE INDEX IF NOT EXISTS wake_deliveries_state ON wake_deliveries (state, conversation_id)",
	);
	// The feed's newest-N window walks this; without it every feed read
	// (a 15s poll per open page) full-scans work_events.
	db.run(
		"CREATE INDEX IF NOT EXISTS work_events_resp ON work_events (responsibility_id, event_id DESC)",
	);
	// The feed's wake join and record()'s event→wake lookup hit event_id;
	// the PK leads with wake_id, so both full-scanned wake_events.
	db.run("CREATE INDEX IF NOT EXISTS wake_events_event ON wake_events (event_id)");
}

// deleteConversation's wake sweep — joins its transaction, so no
// transaction of its own: the caller's commit or rollback decides
// whether the deletions stick. Wake rows are delivery bookkeeping for
// a conversation; when the conversation goes, they go with it.
export function sweepConversationWakes(
	db: Database,
	conversationId: string,
): { wakes: number; workEvents: number } {
	db.query(
		"DELETE FROM wake_events WHERE wake_id IN (SELECT wake_id FROM wake_deliveries WHERE conversation_id = ?)",
	).run(conversationId);
	const workEvents = db
		.query("DELETE FROM work_events WHERE conversation_id = ?")
		.run(conversationId).changes;
	const wakes = db
		.query("DELETE FROM wake_deliveries WHERE conversation_id = ?")
		.run(conversationId).changes;
	return { wakes, workEvents };
}

export function openWakeStore(db: Database): WakeStore {
	ensureWakeSchema(db);

	const qEventByKey = db.query<z.infer<typeof eventIdentitySchema>, [string]>(
		"SELECT event_id, conversation_id, kind, text FROM work_events WHERE source_key = ?",
	);
	const qInsertEvent = db.prepare(
		"INSERT INTO work_events (source_key, conversation_id, kind, text, facts_json, origin, responsibility_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const qWakeForEvent = db.query<{ wake_id: number }, [number]>(
		"SELECT wake_id FROM wake_events WHERE event_id = ?",
	);
	const qPendingWake = db.query<{ wake_id: number }, [string]>(
		"SELECT wake_id FROM wake_deliveries WHERE conversation_id = ? AND state = 'pending' ORDER BY wake_id DESC LIMIT 1",
	);
	const qInsertWake = db.prepare(
		"INSERT INTO wake_deliveries (conversation_id, message_id, state, created_at) VALUES (?, ?, 'pending', ?)",
	);
	const qLinkEvent = db.prepare("INSERT INTO wake_events (wake_id, event_id) VALUES (?, ?)");
	const qWake = db.query<WakeRow, [number]>("SELECT * FROM wake_deliveries WHERE wake_id = ?");
	const qWakeEvents = db.query<z.infer<typeof eventRefSchema>, [number]>(
		"SELECT e.event_id, e.source_key, e.text FROM wake_events w JOIN work_events e ON e.event_id = w.event_id WHERE w.wake_id = ? ORDER BY e.event_id",
	);
	const qPending = db.query<WakeRow, [string]>(
		"SELECT * FROM wake_deliveries WHERE state = 'pending' AND conversation_id = ? ORDER BY wake_id",
	);
	const qPendingAll = db.query<WakeRow, []>(
		"SELECT * FROM wake_deliveries WHERE state = 'pending' ORDER BY wake_id",
	);
	const qByRun = db.query<WakeRow, [string]>(
		"SELECT * FROM wake_deliveries WHERE run_id = ? ORDER BY wake_id",
	);
	const qOpenAll = db.query<WakeRow, []>(
		"SELECT * FROM wake_deliveries WHERE state IN ('pending','claimed') ORDER BY wake_id",
	);
	const qLastEvent = db.query<{ seq: number; data: string }, [string]>(
		"SELECT seq, data FROM events WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
	);
	const qClaim = db.prepare(
		"UPDATE wake_deliveries SET state = 'claimed', history_seq = ?, claimed_at = ?, claim_epoch = (SELECT epoch FROM conversations WHERE id = wake_deliveries.conversation_id) WHERE wake_id = ? AND state = 'pending'",
	);
	const qEpoch = db.query<{ epoch: number }, [string]>(
		"SELECT epoch FROM conversations WHERE id = ?",
	);
	const qLinkRun = db.prepare(
		"UPDATE wake_deliveries SET run_id = ?, next_attempt_at = NULL WHERE wake_id = ? AND state = 'claimed'",
	);
	const qSettle = db.prepare(
		"UPDATE wake_deliveries SET state = ?, settled_at = ?, last_error = COALESCE(?, last_error) WHERE wake_id = ? AND state = 'claimed'",
	);
	// The orphan claim satisfies the terminal-state CHECK (history_seq
	// NOT NULL) without inventing a history reference: -1 marks a
	// trigger that was never appended anywhere.
	const qClaimOrphan = db.prepare(
		"UPDATE wake_deliveries SET state = 'claimed', history_seq = -1, claimed_at = ?, claim_epoch = NULL WHERE wake_id = ? AND state = 'pending'",
	);
	const qNoteFailure = db.prepare(
		"UPDATE wake_deliveries SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE wake_id = ? AND state = 'claimed'",
	);
	// The fail-closed twin of failOrphan: a claimed wake that could not
	// take its run link. run_id IS NULL is the CAS — a wake linked
	// meanwhile keeps its owner and its ordinary settlement path.
	const qFailUnlinked = db.prepare(
		"UPDATE wake_deliveries SET state = 'failed', settled_at = ?, last_error = ? WHERE wake_id = ? AND state = 'claimed' AND run_id IS NULL",
	);

	function rowToRecord(row: WakeRow): WakeRecord {
		const parsed = wakeRowSchema.parse(row);
		const events = qWakeEvents.all(parsed.wake_id).map((e) => eventRefSchema.parse(e));
		return {
			wakeId: parsed.wake_id,
			conversationId: parsed.conversation_id,
			messageId: parsed.message_id,
			state: parsed.state,
			historySeq: parsed.history_seq,
			claimEpoch: parsed.claim_epoch,
			runId: parsed.run_id,
			attempts: parsed.attempts,
			lastError: parsed.last_error,
			nextAttemptAt: parsed.next_attempt_at,
			createdAt: parsed.created_at,
			claimedAt: parsed.claimed_at,
			settledAt: parsed.settled_at,
			text: events.map((e) => e.text).join("\n"),
			events: events.map((e) => ({ eventId: e.event_id, sourceKey: e.source_key })),
		};
	}

	function requireWake(wakeId: number): WakeRecord {
		const rec = store.get(wakeId);
		if (rec === null) throw new Error(`wake ${wakeId} not found`);
		return rec;
	}

	const store: WakeStore = {
		record(input) {
			if (input.sourceKey === "" || input.conversationId === "" || input.text === "") {
				throw new Error("wake development needs a source key, conversation, and text");
			}
			const now = new Date().toISOString();
			let outcome: { eventId: number; wakeId: number; created: boolean } | null = null;
			db.transaction(() => {
				const existing = qEventByKey.get(input.sourceKey);
				if (existing != null) {
					const identity = eventIdentitySchema.parse(existing);
					if (identity.conversation_id !== input.conversationId || identity.kind !== input.kind) {
						throw new Error(`work event ${input.sourceKey} replayed with a different identity`);
					}
					if (identity.text !== input.text) {
						if (input.replay !== true) {
							throw new Error(`work event ${input.sourceKey} replayed with a different identity`);
						}
						// The recorded occurrence stands — mutable state moved
						// since it fired, and the next occurrence carries the
						// fresher view.
						log.warn("wake development replayed — mutable state drifted since the record", {
							sourceKey: input.sourceKey,
							event: identity.event_id,
						});
					}
					const link = qWakeForEvent.get(identity.event_id);
					if (link == null) {
						throw new Error(`work event ${input.sourceKey} has no wake link`);
					}
					outcome = { eventId: identity.event_id, wakeId: link.wake_id, created: false };
					return;
				}
				const inserted = qInsertEvent.run(
					input.sourceKey,
					input.conversationId,
					input.kind,
					input.text,
					JSON.stringify(input.facts ?? null),
					input.origin,
					input.responsibilityId ?? null,
					now,
				);
				const eventId = Number(inserted.lastInsertRowid);
				const pending = qPendingWake.get(input.conversationId);
				let wakeId: number;
				if (pending != null) {
					wakeId = pending.wake_id;
				} else {
					const opened = qInsertWake.run(input.conversationId, `wake-${randomUUID()}`, now);
					wakeId = Number(opened.lastInsertRowid);
				}
				qLinkEvent.run(wakeId, eventId);
				outcome = { eventId, wakeId, created: true };
			})();
			if (outcome === null) throw new Error("wake record transaction produced no outcome");
			const result: { eventId: number; wakeId: number; created: boolean } = outcome;
			if (result.created) {
				log.info("wake development recorded", {
					wake: result.wakeId,
					event: result.eventId,
					conversation: input.conversationId,
					kind: input.kind,
					origin: input.origin,
				});
			} else {
				log.info("wake development deduplicated", {
					wake: result.wakeId,
					event: result.eventId,
					sourceKey: input.sourceKey,
				});
			}
			return result;
		},

		get(wakeId) {
			const row = qWake.get(wakeId);
			return row == null ? null : rowToRecord(row);
		},

		pending(conversationId) {
			const rows = conversationId === undefined ? qPendingAll.all() : qPending.all(conversationId);
			return rows.map(rowToRecord);
		},

		forRun(runId) {
			return qByRun.all(runId).map(rowToRecord);
		},

		claimedForEvents(conversationId, eventSeqs) {
			if (eventSeqs.length === 0) return [];
			const marks = eventSeqs.map(() => "?").join(",");
			const rows = db
				.query<WakeRow, [string, ...number[]]>(
					`SELECT * FROM wake_deliveries WHERE state = 'claimed' AND conversation_id = ? AND history_seq IN (${marks})`,
				)
				.all(conversationId, ...eventSeqs);
			return rows.map(rowToRecord);
		},

		commit(wakeId, append) {
			const now = new Date().toISOString();
			return db.transaction(() => {
				const rec = requireWake(wakeId);
				if (rec.state !== "pending") return rec;
				append({ id: rec.messageId, text: rec.text });
				// The stamp is the durable history reference: verify the
				// append actually landed this trigger, don't trust it.
				const last = qLastEvent.get(rec.conversationId);
				if (last == null) {
					throw new Error(`wake ${wakeId} append left no history event`);
				}
				const parsed = appendedEventSchema.safeParse(JSON.parse(last.data));
				if (!parsed.success || parsed.data.message.id !== rec.messageId) {
					throw new Error(`wake ${wakeId} append did not land the trigger message`);
				}
				const claimed = qClaim.run(last.seq, now, wakeId);
				if (claimed.changes !== 1) {
					throw new Error(`wake ${wakeId} claim raced`);
				}
				log.info("wake trigger appended", {
					wake: wakeId,
					conversation: rec.conversationId,
					seq: last.seq,
					events: rec.events.length,
				});
				return requireWake(wakeId);
			})();
		},

		linkRun(wakeId, runId) {
			db.transaction(() => {
				const rec = requireWake(wakeId);
				if (rec.state !== "claimed") {
					throw new Error(`wake ${wakeId} cannot link a run from state ${rec.state}`);
				}
				if (rec.runId !== null && rec.runId !== runId) {
					throw new Error(`wake ${wakeId} already owns run ${rec.runId}`);
				}
				qLinkRun.run(runId, wakeId);
			})();
			log.info("wake run linked", { wake: wakeId, run: runId });
		},

		retargetRun(wakeId, fromRunId, toRunId) {
			db.transaction(() => {
				const rec = requireWake(wakeId);
				if (rec.state !== "claimed" || rec.runId !== fromRunId) {
					throw new Error(
						`wake ${wakeId} does not own run ${fromRunId} (state ${rec.state}, run ${rec.runId})`,
					);
				}
				qLinkRun.run(toRunId, wakeId);
			})();
			log.info("wake run retargeted", { wake: wakeId, from: fromRunId, to: toRunId });
		},

		settle(wakeId, outcome, opts) {
			const now = new Date().toISOString();
			let runId: string | null = null;
			db.transaction(() => {
				const rec = requireWake(wakeId);
				if (rec.state !== "claimed") {
					throw new Error(`wake ${wakeId} cannot settle from state ${rec.state}`);
				}
				runId = rec.runId;
				const updated = qSettle.run(outcome, now, opts?.error ?? null, wakeId);
				if (updated.changes !== 1) throw new Error(`wake ${wakeId} settle raced`);
			})();
			log.info("wake settled", { wake: wakeId, outcome, run: runId, error: opts?.error ?? null });
		},

		failOrphan(wakeId, error) {
			const now = new Date().toISOString();
			db.transaction(() => {
				const rec = requireWake(wakeId);
				if (rec.state !== "pending") {
					throw new Error(`wake ${wakeId} cannot fail as orphan from state ${rec.state}`);
				}
				const claimed = qClaimOrphan.run(now, wakeId);
				if (claimed.changes !== 1) throw new Error(`wake ${wakeId} orphan claim raced`);
				const settled = qSettle.run("failed", now, error, wakeId);
				if (settled.changes !== 1) throw new Error(`wake ${wakeId} orphan settle raced`);
			})();
			log.error("wake orphan failed", undefined, { wake: wakeId, error });
		},

		noteFailure(wakeId, error, nextAttemptAt) {
			let attempts = 0;
			db.transaction(() => {
				const rec = requireWake(wakeId);
				if (rec.state !== "claimed") {
					throw new Error(`wake ${wakeId} cannot record failure from state ${rec.state}`);
				}
				const updated = qNoteFailure.run(error, nextAttemptAt, wakeId);
				if (updated.changes !== 1) throw new Error(`wake ${wakeId} failure note raced`);
				attempts = rec.attempts + 1;
			})();
			log.warn("wake delivery failed", { wake: wakeId, attempt: attempts, error, nextAttemptAt });
		},

		failUnlinked(wakeId, error) {
			const closed = qFailUnlinked.run(new Date().toISOString(), error, wakeId).changes === 1;
			if (closed) {
				log.error("wake ownership never linked — failed closed", undefined, {
					wake: wakeId,
					error,
				});
			}
			return closed;
		},

		reconcile(now, runStatus) {
			const plan: ReconcilePlan = {
				toAppend: [],
				toResubmit: [],
				waitingBackoff: [],
				toSettle: [],
				toFail: [],
				preserved: [],
			};
			for (const row of qOpenAll.all()) {
				// Same ruling as programs.ts decodeScan: one row the schema
				// rejects (drift between versions, a hand edit) must cost that
				// row an error line per pump, not every other wake its
				// delivery — pump() treats a reconcile throw as fatal for the
				// whole pass, so an unguarded row wedges all wake delivery and
				// settlement every tick. The row is skipped, never decoded
				// into a fabricated record.
				let rec: WakeRecord;
				try {
					rec = rowToRecord(row);
				} catch (err) {
					log.error("wake row undecodable — skipped this reconcile", err, {
						wake: row.wake_id,
						conversation: row.conversation_id,
						state: row.state,
					});
					continue;
				}
				if (rec.state === "pending") {
					const conv = qEpoch.get(rec.conversationId);
					if (conv === null) {
						// Out-of-band corruption only — the FK chain and
						// deleteConversation's sweep keep wake rows and their
						// conversation together. Same ruling as the claimed
						// branch below: the orphan fails itself, loudly and
						// terminally (via failOrphan — settle needs a real
						// claim); classification continues for every other
						// wake.
						log.error("pending wake's conversation row is missing", undefined, {
							wake: rec.wakeId,
							conversation: rec.conversationId,
						});
						plan.toFail.push(rec);
						continue;
					}
					plan.toAppend.push(rec);
					continue;
				}
				if (rec.runId === null) {
					const conv = qEpoch.get(rec.conversationId);
					if (conv === null) {
						// Out-of-band corruption only — the FK chain and
						// deleteConversation's sweep keep wake rows and their
						// conversation together. Same ruling as the ghost-run
						// branch below: the corrupt wake fails itself, loudly
						// and terminally; classification must continue for
						// every other wake.
						log.error("wake's conversation row is missing", undefined, {
							wake: rec.wakeId,
							conversation: rec.conversationId,
						});
						plan.toFail.push(rec);
						continue;
					}
					if (rec.claimEpoch === null || rec.claimEpoch !== conv.epoch) {
						plan.toFail.push(rec);
					} else if (rec.nextAttemptAt !== null && rec.nextAttemptAt > now) {
						plan.waitingBackoff.push(rec);
					} else {
						plan.toResubmit.push(rec);
					}
					continue;
				}
				const status = runStatus(rec.runId);
				if (status === null) {
					// The link can't be resolved — a missing run row or a
					// resume-chain cycle. Corruption fails this wake, loudly
					// and terminally; it must not abort classification and
					// stall every other wake's delivery.
					log.error("wake links a run the journal cannot resolve", undefined, {
						wake: rec.wakeId,
						run: rec.runId,
					});
					plan.toFail.push(rec);
					continue;
				}
				if (status === "completed") plan.toSettle.push(rec);
				else if (status === "error" || status === "fenced" || status === "abandoned") {
					plan.toFail.push(rec);
				} else plan.preserved.push(rec);
			}
			log.info("wake reconcile", {
				toAppend: plan.toAppend.length,
				toResubmit: plan.toResubmit.length,
				waitingBackoff: plan.waitingBackoff.length,
				toSettle: plan.toSettle.length,
				toFail: plan.toFail.length,
				preserved: plan.preserved.length,
			});
			return plan;
		},
	};
	return store;
}
