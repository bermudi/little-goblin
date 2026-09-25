// Persistent-outage episodes for memory retention (DESIGN.md, Slice 2
// ruling 5, 2026-09-24 amendment). The no-spam ruling covers per-retry
// notifications; a retention chain that cannot drain for a full hour
// earns exactly ONE operator notice per episode, addressed to the
// conversation whose exchange is stuck in the outbox. Any successful
// advance ends the episode silently. Episode state is SQLite, so a
// restart neither forgets an unnotified outage nor repeats a sent one.
import { type Database } from "bun:sqlite";
import { log } from "./log.ts";

// How long a continuous outage must last before the operator hears about
// it. Retention is durable — an outage costs queue latency, never data —
// so the threshold skews quiet on purpose.
export const OUTAGE_NOTICE_AFTER_MS = 60 * 60 * 1000;

type OutageRow = { started_at: number; conversation: string; notified: number };

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
	}

	// Every worker transport failure passes through here. Returns the
	// notice to send once the threshold is crossed and the previous send
	// (if any) never confirmed; null before the threshold or after a
	// confirmed send. recordFailure never marks the send itself — the
	// caller does on delivery success, so a failed Telegram send retries
	// on the next worker failure, never in a tight loop.
	recordFailure(conversationId: string): { conversation: string; sinceMs: number } | null {
		const now = this.clock();
		const row = this.row();
		if (!row) {
			this.db.run(
				"INSERT INTO memory_outage (id, started_at, conversation) VALUES (1, ?, ?)",
				[now, conversationId],
			);
			log.warn("memory outage started", { conversation: conversationId });
			return null;
		}
		const sinceMs = now - row.started_at;
		if (row.notified === 1 || sinceMs < OUTAGE_NOTICE_AFTER_MS) return null;
		log.warn("memory outage persists — operator notice due", {
			conversation: row.conversation,
			sinceMs,
		});
		return { conversation: row.conversation, sinceMs };
	}

	markNotified(): void {
		this.db.run("UPDATE memory_outage SET notified = 1 WHERE id = 1");
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
			this.db.query<OutageRow, []>(
				"SELECT started_at, conversation, notified FROM memory_outage WHERE id = 1",
			).get() ?? null
		);
	}
}
