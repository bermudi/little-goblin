// Persistent-outage episodes for memory retention (DESIGN.md, Slice 2
// ruling 5, 2026-09-24 amendment). The no-spam ruling covers per-retry
// notifications; a retention chain that cannot drain for a full hour
// earns exactly ONE notice per episode, addressed to the conversation
// whose exchange is stuck in the outbox. Any successful advance ends
// the episode silently. Episode state is SQLite, so a restart neither
// forgets an unnotified outage nor repeats a sent one.
//
// "Continuous" is defined by failure cadence, not by row age: a live
// outage produces a failure at least every ~5m10s (backoff cap + tick
// interval), so an episode whose last failure is older than
// STALE_AFTER_MS is over — typically because the outbox emptied through
// cancellation (/memory off, /forget) without a success ever being
// observed. The next failure starts a fresh episode; a weeks-old row
// can never make a new outage notify instantly.
import { type Database } from "bun:sqlite";
import { log } from "./log.ts";

// How long a continuous outage must last before the operator hears about
// it. Retention is durable — an outage costs queue latency, never data —
// so the threshold skews quiet on purpose.
export const OUTAGE_NOTICE_AFTER_MS = 60 * 60 * 1000;

// A gap between failures longer than this ends the episode (see above).
// Generously above the ~5m10s worst-case cadence so a slow API restart
// or a long migration window never splits one real outage in two.
export const OUTAGE_STALE_AFTER_MS = 15 * 60 * 1000;

type OutageRow = {
	started_at: number;
	last_failure: number;
	conversation: string;
	notified: number;
};

export interface OutageNotice {
	conversation: string;
	sinceMs: number;
	// The episode's started_at — the identity markNotified() scopes to,
	// so a send resolving after the episode was cleared and replaced can
	// never silence its successor (review finding: unscoped marks let a
	// late send mute a brand-new episode forever).
	episode: number;
}

export class OutageTracker {
	constructor(
		private readonly db: Database,
		private readonly clock: () => number = Date.now,
	) {
		db.run(`CREATE TABLE IF NOT EXISTS memory_outage (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			started_at INTEGER NOT NULL,
			conversation TEXT NOT NULL,
			notified INTEGER NOT NULL DEFAULT 0
		)`);
		// Additive migration, the conversation.ts anchor_seq pattern.
		const cols = new Set(
			db
				.query<{ name: string }, []>("PRAGMA table_info(memory_outage)")
				.all()
				.map((c) => c.name),
		);
		if (!cols.has("last_failure")) {
			db.run("ALTER TABLE memory_outage ADD COLUMN last_failure INTEGER NOT NULL DEFAULT 0");
		}
	}

	// Every worker transport failure passes through here. Returns the
	// notice to send once the threshold is crossed and no send for this
	// episode is awaiting confirmation; null before the threshold, after
	// a confirmed send, or while another caller's send is in flight (the
	// caller-side latch makes that window process-local — see
	// startMemoryWorker). recordFailure never marks the send itself; the
	// caller does on delivery success, so a failed Telegram send retries
	// on the next worker failure, never in a loop.
	recordFailure(conversationId: string): OutageNotice | null {
		const now = this.clock();
		const row = this.row();
		if (!row) {
			this.db.run(
				"INSERT INTO memory_outage (id, started_at, last_failure, conversation) VALUES (1, ?, ?, ?)",
				[now, now, conversationId],
			);
			log.warn("memory outage started", { conversation: conversationId });
			return null;
		}
		if (now - row.last_failure > OUTAGE_STALE_AFTER_MS) {
			this.db.run(
				"UPDATE memory_outage SET started_at = ?, last_failure = ?, conversation = ?, notified = 0 WHERE id = 1",
				[now, now, conversationId],
			);
			log.warn("memory outage episode reset — prior episode went stale without a success", {
				conversation: conversationId,
				priorSinceMs: row.last_failure - row.started_at,
			});
			return null;
		}
		this.db.run("UPDATE memory_outage SET last_failure = ? WHERE id = 1", [now]);
		const sinceMs = now - row.started_at;
		if (row.notified === 1 || sinceMs < OUTAGE_NOTICE_AFTER_MS) return null;
		log.warn("memory outage persists — operator notice due", {
			conversation: row.conversation,
			sinceMs,
		});
		return { conversation: row.conversation, sinceMs, episode: row.started_at };
	}

	// Confirms the send for exactly this episode. A mark arriving after
	// the episode was cleared and replaced is a no-op by design.
	markNotified(episode: number): void {
		this.db.run("UPDATE memory_outage SET notified = 1 WHERE id = 1 AND started_at = ?", [episode]);
	}

	// Any advance (submit acknowledged, operation completed) proves the
	// whole chain — goblin, API, database — alive; the episode ends
	// without a word. Idempotent: no episode, no event.
	recordSuccess(): void {
		const row = this.row();
		if (!row) return;
		this.db.run("DELETE FROM memory_outage WHERE id = 1");
		log.info("memory outage cleared", { sinceMs: this.clock() - row.started_at });
	}

	private row(): OutageRow | null {
		return (
			this.db
				.query<OutageRow, []>(
					"SELECT started_at, last_failure, conversation, notified FROM memory_outage WHERE id = 1",
				)
				.get() ?? null
		);
	}
}
