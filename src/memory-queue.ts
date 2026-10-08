// Durable retention outbox. Shares the conversation store's SQLite connection:
// enqueue inside the history append transaction, never after it.
import { type Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	HindsightClient,
	HindsightError,
	memoryDocumentSchema,
	type MemoryDocument,
} from "./hindsight.ts";
import { log } from "./log.ts";

const targetSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface MemoryQueueCounts {
	pending: number;
	submitted: number;
	completed: number;
	blocked: number;
	dismissed: number;
}
// Operator-facing projection of a blocked row. `document` is the last
// path segment of the document id when it contains one (the assistant
// message id — enough to point the operator at the exchange); `error` is
// capped for chat surfaces.
export interface BlockedRetention {
	document: string;
	error: string | null;
	attempts: number;
}
const rowSchema = z.object({
	operation_id: z.uuid(),
	target: targetSchema,
	document_id: z.string(),
	payload: z.string(),
	// `dismissed`: the operator reviewed a blocked row and chose to drop
	// it. The row stays in the DB for audit — failed/missing remote
	// operations remain visible, never silently discarded.
	state: z.enum(["pending", "submitted", "completed", "blocked", "dismissed"]),
	attempts: z.number().int().nonnegative(),
	next_attempt: z.number().int().nonnegative(),
	error: z.string().nullable(),
});
export type MemoryQueueItem = Omit<z.infer<typeof rowSchema>, "payload"> & {
	document: MemoryDocument;
};

export class MemoryQueue {
	constructor(private readonly db: Database) {
		db.run(`CREATE TABLE IF NOT EXISTS memory_outbox (
			operation_id TEXT PRIMARY KEY,
			target TEXT NOT NULL,
			document_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			UNIQUE(target, document_id)
		)`);
		db.run(
			"CREATE INDEX IF NOT EXISTS memory_outbox_due ON memory_outbox(target, state, next_attempt)",
		);
		// One-notice-per-document latch for blocked retention (the other
		// half of the 2026-09-25 incident: nothing in chat ever surfaced a
		// blocked document). A row here means the operator was already
		// told once; it is never cleared — /memory status is the durable
		// surface for everything after the first notice.
		db.run(`CREATE TABLE IF NOT EXISTS memory_blocked_notices (
			document_id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		)`);
	}

	// Returns the same operation for an exact replay; never overwrites pending
	// content or resets a terminal operation. Caller logs only after committing.
	enqueue(target: string, document: MemoryDocument): string {
		targetSchema.parse(target);
		const doc = memoryDocumentSchema.parse(document);
		const payload = JSON.stringify(doc);
		const existing = this.db
			.query<{ operation_id: string; payload: string }, [string, string]>(
				"SELECT operation_id, payload FROM memory_outbox WHERE target = ? AND document_id = ?",
			)
			.get(target, doc.id);
		if (existing) {
			if (existing.payload !== payload)
				throw new Error("Memory document identity reused with different content");
			return z.uuid().parse(existing.operation_id);
		}
		const id = randomUUID();
		this.db.run(
			"INSERT INTO memory_outbox (operation_id, target, document_id, payload) VALUES (?, ?, ?, ?)",
			[id, target, doc.id, payload],
		);
		return id;
	}

	private decode(raw: unknown): MemoryQueueItem {
		const row = rowSchema.safeParse(raw);
		if (!row.success) throw new Error("Invalid memory queue row");
		let payload: unknown;
		try {
			payload = JSON.parse(row.data.payload);
		} catch {
			throw new Error(`Invalid memory queue payload for operation ${row.data.operation_id}`);
		}
		const document = memoryDocumentSchema.safeParse(payload);
		if (!document.success || document.data.id !== row.data.document_id) {
			throw new Error(`Invalid memory document for operation ${row.data.operation_id}`);
		}
		const { payload: _payload, ...fields } = row.data;
		return { ...fields, document: document.data };
	}

	// Due pending submissions outrank polling already-acknowledged
	// operations: a submitted row's poll is bookkeeping, while a due
	// pending row is unsent work. Ordering by rowid alone let an early
	// submitted row — re-polled at every backoff interval — continually
	// outrank every later enqueue. rowid still orders within each state,
	// so submitted rows poll FIFO among themselves.
	next(target: string, now: number): MemoryQueueItem | null {
		targetSchema.parse(target);
		const raw = this.db
			.query(
				`SELECT * FROM memory_outbox WHERE target = ? AND state IN ('pending', 'submitted')
			 AND next_attempt <= ? ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END, rowid LIMIT 1`,
			)
			.get(target, now);
		return raw === null ? null : this.decode(raw);
	}

	get(operationId: string): MemoryQueueItem | null {
		z.uuid().parse(operationId);
		const raw = this.db
			.query("SELECT * FROM memory_outbox WHERE operation_id = ?")
			.get(operationId);
		return raw === null ? null : this.decode(raw);
	}

	update(
		item: MemoryQueueItem,
		state: MemoryQueueItem["state"],
		nextAttempt: number,
		error: string | null,
	): void {
		const change = this.db.run(
			`UPDATE memory_outbox SET state = ?, next_attempt = ?, attempts = attempts + 1, error = ?
			 WHERE operation_id = ? AND state = ? AND attempts = ?`,
			[state, nextAttempt, error, item.operation_id, item.state, item.attempts],
		);
		if (change.changes !== 1) throw new Error("Memory queue changed during processing");
		log.info("memory queue transition", {
			operation: item.operation_id,
			document: item.document_id,
			target: item.target,
			from: item.state,
			to: state,
			attempts: item.attempts + 1,
			nextAttempt,
			error,
		});
	}

	// In-flight retention for one document, across every target. Pending
	// rows were never sent (safe to cancel outright); submitted rows are
	// acknowledged and may still be processing remotely — /forget settles
	// those before deleting, or a replace-mode retain finishing after the
	// delete re-creates the document with its local row already gone
	// (DESIGN.md: serialize against in-flight writes before deleting).
	inflightOps(documentId: string): { operationId: string; state: "pending" | "submitted" }[] {
		const state = z.enum(["pending", "submitted"]);
		const rows = this.db
			.query<{ operation_id: string; state: string }, [string]>(
				`SELECT operation_id, state FROM memory_outbox WHERE document_id = ? AND state IN ('pending', 'submitted')`,
			)
			.all(documentId);
		return rows.map((row) => ({
			operationId: z.uuid().parse(row.operation_id),
			state: state.parse(row.state),
		}));
	}

	// Forgetting cancels pending ingestion across all targets — a config
	// change must not resurrect a suppressed document from another
	// target. Blocked and dismissed rows die too: a forgotten document
	// must not linger as "needs review" in the outbox (live finding
	// 2026-09-25: /forget delete used to leave blocked rows behind).
	cancelDocument(documentId: string): number {
		const change = this.db.run(
			`DELETE FROM memory_outbox WHERE document_id = ? AND state IN ('pending', 'submitted', 'blocked', 'dismissed')`,
			[documentId],
		);
		return Number(change.changes);
	}

	// Excluding a topic purges its pending retention — "/memory off"
	// promises no new submissions. Submitted operations were already
	// accepted remotely and must remain tracked through completion.
	// Finished, blocked, and other topics' rows are untouched.
	cancelConversation(conversationId: string): number {
		const rows = this.db
			.query<{ operation_id: string; payload: string }, []>(
				`SELECT operation_id, payload FROM memory_outbox WHERE state = 'pending'`,
			)
			.all();
		let removed = 0;
		for (const row of rows) {
			let payload: unknown;
			try {
				payload = JSON.parse(row.payload);
			} catch {
				throw new Error(`Invalid memory queue payload for operation ${row.operation_id}`);
			}
			const doc = memoryDocumentSchema.safeParse(payload);
			if (!doc.success) {
				throw new Error(`Invalid memory document for operation ${row.operation_id}`);
			}
			if (doc.data.conversationId === conversationId) {
				removed += Number(
					this.db.run("DELETE FROM memory_outbox WHERE operation_id = ? AND state = 'pending'", [
						row.operation_id,
					]).changes,
				);
			}
		}
		return removed;
	}

	counts(target: string): MemoryQueueCounts {
		targetSchema.parse(target);
		const rows = this.db
			.query<{ state: string; n: number }, [string]>(
				`SELECT state, COUNT(*) AS n FROM memory_outbox WHERE target = ? GROUP BY state`,
			)
			.all(target);
		const out: MemoryQueueCounts = {
			pending: 0,
			submitted: 0,
			completed: 0,
			blocked: 0,
			dismissed: 0,
		};
		for (const r of rows) {
			if (r.state === "pending") out.pending = r.n;
			else if (r.state === "submitted") out.submitted = r.n;
			else if (r.state === "completed") out.completed = r.n;
			else if (r.state === "blocked") out.blocked = r.n;
			else if (r.state === "dismissed") out.dismissed = r.n;
		}
		return out;
	}

	// Hand-requeue after an operator reviews a blocked retention. CRITICAL:
	// a fresh randomUUID() is minted, not the old operation_id reused —
	// Hindsight treats the original op as terminally failed server-side,
	// so replaying it just re-reads the dead op's failed status forever
	// (live finding 2026-09-25: flipping state back to pending alone
	// never drained). In-place UPDATE, so UNIQUE(target, document_id)
	// still holds.
	retryBlocked(target: string): number {
		targetSchema.parse(target);
		const rows = this.db
			.query<{ operation_id: string; document_id: string }, [string]>(
				"SELECT operation_id, document_id FROM memory_outbox WHERE target = ? AND state = 'blocked'",
			)
			.all(target);
		for (const row of rows) {
			const fresh = randomUUID();
			const change = this.db.run(
				`UPDATE memory_outbox SET operation_id = ?, state = 'pending', attempts = 0, next_attempt = 0, error = NULL
				 WHERE operation_id = ? AND state = 'blocked'`,
				[fresh, row.operation_id],
			);
			if (change.changes !== 1) throw new Error("Memory queue changed during retry");
			log.info("memory blocked retention requeued with fresh operation", {
				target,
				document: row.document_id,
				operation: abbrevOperation(row.operation_id),
				operationNew: abbrevOperation(fresh),
			});
		}
		return rows.length;
	}

	// The operator reviewed the blocked rows and chose to drop them. The
	// rows stay in the DB (state='dismissed') for audit — they are never
	// selected by next() again.
	dismissBlocked(target: string): number {
		targetSchema.parse(target);
		const rows = this.db
			.query<{ operation_id: string; document_id: string }, [string]>(
				"SELECT operation_id, document_id FROM memory_outbox WHERE target = ? AND state = 'blocked'",
			)
			.all(target);
		for (const row of rows) {
			const change = this.db.run(
				"UPDATE memory_outbox SET state = 'dismissed' WHERE operation_id = ? AND state = 'blocked'",
				[row.operation_id],
			);
			if (change.changes !== 1) throw new Error("Memory queue changed during dismiss");
			log.info("memory blocked retention dismissed", { target, document: row.document_id });
		}
		return rows.length;
	}

	// The one-notice-per-document latch: true only on the first block of
	// this document (ever — including across restarts). Commits before
	// any notice is sent, so a failed delivery does not re-notify;
	// /memory status remains the durable fallback surface.
	noteBlocked(documentId: string): boolean {
		const change = this.db.run(
			"INSERT OR IGNORE INTO memory_blocked_notices (document_id, created_at) VALUES (?, ?)",
			[documentId, new Date().toISOString()],
		);
		return change.changes === 1;
	}

	blockedDetail(target: string): BlockedRetention[] {
		targetSchema.parse(target);
		const rows = this.db
			.query<{ document_id: string; error: string | null; attempts: number }, [string]>(
				"SELECT document_id, error, attempts FROM memory_outbox WHERE target = ? AND state = 'blocked' ORDER BY rowid LIMIT 10",
			)
			.all(target);
		return rows.map((r) => ({
			document: r.document_id.includes("/")
				? (r.document_id.split("/").pop() ?? r.document_id)
				: r.document_id,
			error: r.error === null ? null : r.error.slice(0, 120),
			attempts: r.attempts,
		}));
	}
}

function abbrevOperation(id: string): string {
	return id.slice(0, 8);
}

// Outcome of one processed item, for the outage tracker (memory-outage.ts)
// and the blocked-notice latch: transport failures are outage signals;
// blocked is a permanent per-document verdict with the service
// reachable and advances nothing — it carries the document + error so
// the seam can fire the one-per-document notice.
export type WorkerOutcome =
	| { ok: true; conversationId: string }
	| { ok: false; transport: true; conversationId: string }
	| {
			ok: false;
			transport: false;
			conversationId: string;
			documentId: string;
			error: string | null;
			attempts: number;
	  };

// One caller/process owns the outbox. tick() coalesces concurrent invocations;
// it deliberately has no timer or implicit network activity at construction.
export class MemoryQueueWorker {
	private running: Promise<boolean> | null = null;

	constructor(
		private readonly queue: MemoryQueue,
		private readonly client: HindsightClient,
		private readonly clock: () => number = Date.now,
		private readonly observe?: (outcome: WorkerOutcome) => void,
	) {}

	tick(signal?: AbortSignal): Promise<boolean> {
		if (this.running) return this.running;
		const running = this.process(signal).finally(() => {
			this.running = null;
		});
		this.running = running;
		return running;
	}

	private async process(signal: AbortSignal | undefined): Promise<boolean> {
		if (signal?.aborted) return false;
		const item = this.queue.next(this.client.target, this.clock());
		if (!item) return false;
		let state: MemoryQueueItem["state"];
		let delayMs = 5_000;
		let error: string | null = null;
		let transportFailure = false;
		try {
			if (item.state === "pending") {
				await this.client.submit(item.document, item.operation_id, signal);
				state = "submitted";
			} else {
				const operation = await this.client.operation(item.operation_id, signal);
				if (!operation) {
					// Hindsight prunes operation records. Absence isn't proof of
					// non-execution: never blindly re-submit already acknowledged work.
					state = "blocked";
					error = "operation missing; operator reconciliation required";
				} else if (operation.status === "completed") {
					state = "completed";
				} else if (operation.status === "failed" || operation.status === "cancelled") {
					state = "blocked";
					error = `remote operation ${operation.status}`;
				} else {
					state = "submitted";
				}
			}
		} catch (err) {
			if (!(err instanceof HindsightError)) throw err; // SQLite/programming failures are not HTTP outages.
			if (err.kind === "cancelled") return false; // Keep the durable row for restart.
			state = err.retryable ? item.state : "blocked";
			delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(item.attempts, 9));
			error = err.message; // HindsightError is deliberately payload-free.
			transportFailure = err.retryable;
		}
		// A late shutdown must not discard an already acknowledged operation.
		this.queue.update(item, state, this.clock() + delayMs, error);
		const conversationId = item.document.conversationId;
		if (transportFailure) this.observe?.({ ok: false, transport: true, conversationId });
		else if (state === "submitted" || state === "completed")
			this.observe?.({ ok: true, conversationId });
		else
			this.observe?.({
				ok: false,
				transport: false,
				conversationId,
				documentId: item.document_id,
				error,
				attempts: item.attempts + 1,
			});
		return true;
	}
}
