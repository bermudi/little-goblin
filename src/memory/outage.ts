import { type Database } from "bun:sqlite";
import { log } from "../log.ts";

export const OUTAGE_NOTICE_AFTER_MS = 60 * 60 * 1000;

// Must exceed the worst-case live failure cadence (backoff cap + tick interval,
// ~5m10s) or a continuous outage degrades into ever-resetting episodes and the
// notice never fires.
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

	markNotified(episode: number): void {
		this.db.run("UPDATE memory_outage SET notified = 1 WHERE id = 1 AND started_at = ?", [episode]);
	}

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
