// Durable retention outbox. Shares the conversation store's SQLite connection:
// enqueue inside the history append transaction, never after it.
import { type Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	HindsightClient, HindsightError,
	memoryDocumentSchema, type MemoryDocument,
} from "./hindsight.ts";
import { log } from "./log.ts";

const targetSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.object({
	operation_id: z.uuid(),
	target: targetSchema,
	document_id: z.string(),
	payload: z.string(),
	state: z.enum(["pending", "submitted", "completed", "blocked"]),
	attempts: z.number().int().nonnegative(),
	next_attempt: z.number().int().nonnegative(),
	error: z.string().nullable(),
});
export type MemoryQueueItem = Omit<z.infer<typeof rowSchema>, "payload"> & { document: MemoryDocument };

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
		db.run("CREATE INDEX IF NOT EXISTS memory_outbox_due ON memory_outbox(target, state, next_attempt)");
	}

	// Returns the same operation for an exact replay; never overwrites pending
	// content or resets a terminal operation. Caller logs only after committing.
	enqueue(target: string, document: MemoryDocument): string {
		targetSchema.parse(target);
		const doc = memoryDocumentSchema.parse(document);
		const payload = JSON.stringify(doc);
		const existing = this.db.query<{ operation_id: string; payload: string }, [string, string]>(
			"SELECT operation_id, payload FROM memory_outbox WHERE target = ? AND document_id = ?",
		).get(target, doc.id);
		if (existing) {
			if (existing.payload !== payload) throw new Error("Memory document identity reused with different content");
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
		try { payload = JSON.parse(row.data.payload); } catch {
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
		const raw = this.db.query(
			`SELECT * FROM memory_outbox WHERE target = ? AND state IN ('pending', 'submitted')
			 AND next_attempt <= ? ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END, rowid LIMIT 1`,
		).get(target, now);
		return raw === null ? null : this.decode(raw);
	}

	get(operationId: string): MemoryQueueItem | null {
		z.uuid().parse(operationId);
		const raw = this.db.query("SELECT * FROM memory_outbox WHERE operation_id = ?").get(operationId);
		return raw === null ? null : this.decode(raw);
	}

		update(item: MemoryQueueItem, state: MemoryQueueItem["state"], nextAttempt: number, error: string | null): void {
		const change = this.db.run(
			`UPDATE memory_outbox SET state = ?, next_attempt = ?, attempts = attempts + 1, error = ?
			 WHERE operation_id = ? AND state = ? AND attempts = ?`,
			[state, nextAttempt, error, item.operation_id, item.state, item.attempts],
		);
		if (change.changes !== 1) throw new Error("Memory queue changed during processing");
		log.info("memory queue transition", {
			operation: item.operation_id, document: item.document_id, target: item.target,
			from: item.state, to: state, attempts: item.attempts + 1, nextAttempt, error,
		});
	}

	// Forgetting cancels pending ingestion across all targets — a config
	// change must not resurrect a suppressed document from another target.
	cancelDocument(documentId: string): number {
		const change = this.db.run(
			`DELETE FROM memory_outbox WHERE document_id = ? AND state IN ('pending', 'submitted')`,
			[documentId],
		);
		return Number(change.changes);
	}

	// Excluding a topic purges its pending retention — "/memory off"
	// promises nothing from here is sent. Finished, blocked, and other
	// topics' rows are untouched.
	cancelConversation(conversationId: string): number {
		const rows = this.db.query<{ operation_id: string; payload: string }, []>(
			`SELECT operation_id, payload FROM memory_outbox WHERE state IN ('pending', 'submitted')`,
		).all();
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
				this.db.run("DELETE FROM memory_outbox WHERE operation_id = ?", [row.operation_id]);
				removed++;
			}
		}
		return removed;
	}

	counts(target: string): { pending: number; submitted: number; completed: number; blocked: number } {
		targetSchema.parse(target);
		const rows = this.db.query<{ state: string; n: number }, [string]>(
			`SELECT state, COUNT(*) AS n FROM memory_outbox WHERE target = ? GROUP BY state`,
		).all(target);
		const out = { pending: 0, submitted: 0, completed: 0, blocked: 0 };
		for (const r of rows) {
			if (r.state === "pending") out.pending = r.n;
			else if (r.state === "submitted") out.submitted = r.n;
			else if (r.state === "completed") out.completed = r.n;
			else if (r.state === "blocked") out.blocked = r.n;
		}
		return out;
	}
}

// One caller/process owns the outbox. tick() coalesces concurrent invocations;
// it deliberately has no timer or implicit network activity at construction.
export class MemoryQueueWorker {
	private running: Promise<boolean> | null = null;

	constructor(
		private readonly queue: MemoryQueue,
		private readonly client: HindsightClient,
		private readonly clock: () => number = Date.now,
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
		}
		// A late shutdown must not discard an already acknowledged operation.
		this.queue.update(item, state, this.clock() + delayMs, error);
		return true;
	}
}
