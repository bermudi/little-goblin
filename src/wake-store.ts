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
	/** Claimed wakes whose trigger message id is in the set — the run
	 *  membership lookup the dispatcher's link hooks use. */
	claimedForMessages(messageIds: string[]): WakeRecord[];
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
	/** Transient pre-execution failure: attempt count, error, next gate. */
	noteFailure(wakeId: number, error: string, nextAttemptAt: string | null): void;
	/** Boot classification against history and journal — reads only. */
	reconcile(now: string, runStatus: (runId: string) => JournalStatus | null): ReconcilePlan;
}

export function openWakeStore(db: Database): WakeStore {
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
	const qNoteFailure = db.prepare(
		"UPDATE wake_deliveries SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE wake_id = ? AND state = 'claimed'",
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
					if (
						identity.conversation_id !== input.conversationId ||
						identity.kind !== input.kind ||
						identity.text !== input.text
					) {
						throw new Error(`work event ${input.sourceKey} replayed with a different identity`);
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

		claimedForMessages(messageIds) {
			if (messageIds.length === 0) return [];
			const marks = messageIds.map(() => "?").join(",");
			const rows = db
				.query<WakeRow, string[]>(
					`SELECT * FROM wake_deliveries WHERE state = 'claimed' AND message_id IN (${marks})`,
				)
				.all(...messageIds);
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
				const rec = rowToRecord(row);
				if (rec.state === "pending") {
					plan.toAppend.push(rec);
					continue;
				}
				if (rec.runId === null) {
					const conv = qEpoch.get(rec.conversationId);
					if (conv === null) throw new Error(`wake ${rec.wakeId} conversation missing`);
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
