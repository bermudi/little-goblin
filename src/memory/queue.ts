import { type Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "../log.ts";
import {
	HindsightClient,
	HindsightError,
	type MemoryDocument,
	memoryDocumentSchema,
	targetHashSchema,
} from "./hindsight.ts";
import { screenMemoryText } from "./screen.ts";

const targetSchema = targetHashSchema;
export interface MemoryQueueCounts {
	pending: number;
	submitted: number;
	completed: number;
	blocked: number;
	dismissed: number;
	deleting: number;
}
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
	state: z.enum(["pending", "submitted", "completed", "blocked", "dismissed", "deleting"]),
	attempts: z.number().int().nonnegative(),
	next_attempt: z.number().int().nonnegative(),
	error: z.string().nullable(),
});
export type MemoryQueueItem = Omit<z.infer<typeof rowSchema>, "payload"> & {
	document: MemoryDocument;
};

export class MemoryQueue {
	private inflight: { operationId: string; cancelRequested: boolean } | null = null;

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
		db.run(`CREATE TABLE IF NOT EXISTS memory_blocked_notices (
			document_id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		)`);
	}

	enqueue(target: string, document: MemoryDocument): string {
		targetSchema.parse(target);
		const parsed = memoryDocumentSchema.parse(document);
		const doc = memoryDocumentSchema.parse({
			...parsed,
			content: screenMemoryText(parsed.content, "retain-queue"),
		});
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

	private quarantine(raw: unknown, err: unknown): void {
		const rowid = (raw as { rowid?: unknown }).rowid;
		const message = err instanceof Error ? err.message : String(err);
		const change =
			typeof rowid === "number"
				? this.db.run(
						`UPDATE memory_outbox SET state = 'blocked', error = ?
						 WHERE rowid = ? AND state IN ('pending', 'submitted')`,
						[`undecodable row: ${message}`.slice(0, 500), rowid],
					)
				: null;
		log.error("memory queue row undecodable — quarantined as blocked", err, {
			rowid,
			parked: change === null ? 0 : Number(change.changes),
		});
	}

	next(target: string, now: number): MemoryQueueItem | null {
		targetSchema.parse(target);
		const query = this.db.query(
			`SELECT rowid, * FROM memory_outbox WHERE target = ? AND state IN ('pending', 'submitted')
			 AND next_attempt <= ? ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END, rowid LIMIT 1`,
		);
		for (;;) {
			const raw = query.get(target, now);
			if (raw === null) return null;
			try {
				return this.decode(raw);
			} catch (err) {
				this.quarantine(raw, err);
				const again = query.get(target, now) as { rowid?: unknown } | null;
				if (again !== null && again.rowid === (raw as { rowid?: unknown }).rowid) throw err;
			}
		}
	}

	beginInflight(operationId: string): void {
		if (this.inflight !== null) {
			throw new Error(`memory queue submit overlap: ${this.inflight.operationId} still in flight`);
		}
		this.inflight = { operationId, cancelRequested: false };
	}

	settleInflight(operationId: string): { cancelRequested: boolean } {
		const current = this.inflight;
		if (current === null || current.operationId !== operationId) {
			throw new Error(`memory queue settle without a matching in-flight operation ${operationId}`);
		}
		this.inflight = null;
		return { cancelRequested: current.cancelRequested };
	}

	dropCancelled(item: MemoryQueueItem): boolean {
		const change = this.db.run(
			`DELETE FROM memory_outbox WHERE operation_id = ? AND state = 'pending' AND attempts = ?`,
			[item.operation_id, item.attempts],
		);
		if (change.changes === 1) {
			log.info("memory retention cancelled after in-flight submit settled unsent", {
				operation: item.operation_id,
				document: item.document_id,
				conversation: item.document.conversationId,
			});
		}
		return change.changes === 1;
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

	documentDestinations(documentId: string): {
		target: string;
		inflight: { operationId: string; state: "pending" | "submitted" }[];
	}[] {
		const state = z.enum(["pending", "submitted"]);
		const rows = this.db
			.query<{ target: string; operation_id: string; state: string }, [string]>(
				`SELECT target, operation_id, state FROM memory_outbox WHERE document_id = ? ORDER BY rowid`,
			)
			.all(documentId);
		const byTarget = new Map<
			string,
			{ target: string; inflight: { operationId: string; state: "pending" | "submitted" }[] }
		>();
		for (const row of rows) {
			const target = targetSchema.parse(row.target);
			let entry = byTarget.get(target);
			if (entry === undefined) {
				entry = { target, inflight: [] };
				byTarget.set(target, entry);
			}
			if (row.state === "pending" || row.state === "submitted") {
				entry.inflight.push({
					operationId: z.uuid().parse(row.operation_id),
					state: state.parse(row.state),
				});
			}
		}
		return [...byTarget.values()];
	}

	markDocumentDeleting(documentId: string): number {
		const rows = Number(
			this.db.run(
				`UPDATE memory_outbox SET state = 'deleting' WHERE document_id = ? AND state != 'deleting'`,
				[documentId],
			).changes,
		);
		if (rows > 0) log.info("memory retention parked for deletion", { document: documentId, rows });
		return rows;
	}

	confirmDeleted(documentId: string, target: string): number {
		targetSchema.parse(target);
		const change = this.db.run("DELETE FROM memory_outbox WHERE document_id = ? AND target = ?", [
			documentId,
			target,
		]);
		return Number(change.changes);
	}

	cancelConversation(conversationId: string): number {
		const rows = this.db
			.query<{ rowid: number; operation_id: string; payload: string }, []>(
				`SELECT rowid, operation_id, payload FROM memory_outbox WHERE state = 'pending'`,
			)
			.all();
		let removed = 0;
		for (const row of rows) {
			let doc: MemoryDocument;
			try {
				const payload: unknown = JSON.parse(row.payload);
				const parsed = memoryDocumentSchema.safeParse(payload);
				if (!parsed.success) {
					throw new Error(`Invalid memory document for operation ${row.operation_id}`);
				}
				doc = parsed.data;
			} catch (err) {
				this.quarantine(row, err);
				continue;
			}
			if (doc.conversationId !== conversationId) continue;
			if (this.inflight !== null && this.inflight.operationId === row.operation_id) {
				this.inflight.cancelRequested = true;
				log.info("memory retention cancel deferred — submit in flight", {
					operation: row.operation_id,
					conversation: conversationId,
				});
				continue;
			}
			removed += Number(
				this.db.run("DELETE FROM memory_outbox WHERE operation_id = ? AND state = 'pending'", [
					row.operation_id,
				]).changes,
			);
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
			deleting: 0,
		};
		for (const r of rows) {
			if (r.state === "pending") out.pending = r.n;
			else if (r.state === "submitted") out.submitted = r.n;
			else if (r.state === "completed") out.completed = r.n;
			else if (r.state === "blocked") out.blocked = r.n;
			else if (r.state === "dismissed") out.dismissed = r.n;
			else if (r.state === "deleting") out.deleting = r.n;
		}
		return out;
	}

	deletingCount(): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM memory_outbox WHERE state = 'deleting'")
			.get() as {
			n: number;
		};
		return row.n;
	}

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
		let cancelRequested = false;
		try {
			if (item.state === "pending") {
				this.queue.beginInflight(item.operation_id);
				try {
					await this.client.submit(item.document, item.operation_id, signal);
				} finally {
					cancelRequested = this.queue.settleInflight(item.operation_id).cancelRequested;
				}
				state = "submitted";
			} else {
				const operation = await this.client.operation(item.operation_id, signal);
				if (!operation) {
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
			if (!(err instanceof HindsightError)) throw err;
			if (err.kind === "cancelled") {
				if (cancelRequested) this.queue.dropCancelled(item);
				return false;
			}
			state = err.retryable ? item.state : "blocked";
			delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(item.attempts, 9));
			error = err.message;
			transportFailure = err.retryable;
		}
		if (cancelRequested && state === "pending" && this.queue.dropCancelled(item)) {
			if (transportFailure)
				this.observe?.({
					ok: false,
					transport: true,
					conversationId: item.document.conversationId,
				});
			return true;
		}
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
