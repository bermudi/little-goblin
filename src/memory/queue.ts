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
	conversationId: string | null;
}
// True counts of everything blocked, not just the first ten rows.
export interface BlockedSummary {
	total: number;
	byConversation: { conversationId: string | null; count: number }[];
	byCause: {
		error: string | null;
		count: number;
		/** Timestamp of the oldest blocked exchange in this cause. */
		since: string | null;
		conversations: { conversationId: string | null; count: number }[];
	}[];
}

/** Which blocked rows an action covers: every one, or one cause (the
 *  first 120 chars of the stored error, as blockedSummary groups them;
 *  null = rows with no error text). */
export type BlockedScope = { error: string | null } | undefined;

const CAUSE_KEY = "substr(error, 1, 120)";
// What happened to the exchanges the last Retry requeued. dismissed and
// deleting rows left the batch by operator choice and are not counted.
export interface RetryProgress {
	startedAt: number;
	done: number;
	queued: number;
	failed: number;
	conversations: { conversationId: string | null; done: number; queued: number; failed: number }[];
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
			settled_at INTEGER,
			retried_at INTEGER,
			UNIQUE(target, document_id)
		)`);
		// settled_at: when the row reached completed. retried_at: the
		// ms timestamp of the Retry that requeued it; rows sharing the
		// newest value are the batch the page reports progress on.
		const columns = new Set(
			db
				.query<{ name: string }, []>("PRAGMA table_info(memory_outbox)")
				.all()
				.map((c) => c.name),
		);
		for (const column of ["settled_at", "retried_at"]) {
			if (!columns.has(column)) db.run(`ALTER TABLE memory_outbox ADD COLUMN ${column} INTEGER`);
		}
		db.run(
			"CREATE INDEX IF NOT EXISTS memory_outbox_due ON memory_outbox(target, state, next_attempt)",
		);
		db.run(`CREATE TABLE IF NOT EXISTS memory_recall_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			at TEXT NOT NULL,
			ok INTEGER NOT NULL
		)`);
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
			`UPDATE memory_outbox SET state = ?, next_attempt = ?, attempts = attempts + 1, error = ?,
			 settled_at = COALESCE(?, settled_at)
			 WHERE operation_id = ? AND state = ? AND attempts = ?`,
			[
				state,
				nextAttempt,
				error,
				state === "completed" ? Date.now() : null,
				item.operation_id,
				item.state,
				item.attempts,
			],
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

	private purgePending(match: (doc: MemoryDocument) => boolean): number {
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
			if (!match(doc)) continue;
			if (this.inflight !== null && this.inflight.operationId === row.operation_id) {
				this.inflight.cancelRequested = true;
				log.info("memory retention cancel deferred — submit in flight", {
					operation: row.operation_id,
					conversation: doc.conversationId,
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

	cancelConversation(conversationId: string): number {
		return this.purgePending((doc) => doc.conversationId === conversationId);
	}

	// An edit deleted the exchanges at and after anchorSeq: their queued
	// retention must not reach the service. The document id is
	// `exchange/<conversation>/<anchor>/<assistant>`; the conversation id
	// itself may contain slashes, so the prefix includes its trailing
	// separator and only the remainder is split.
	cancelAnchoredFrom(conversationId: string, anchorSeq: number): number {
		const prefix = `exchange/${conversationId}/`;
		return this.purgePending((doc) => {
			if (doc.conversationId !== conversationId || !doc.id.startsWith(prefix)) return false;
			const anchor = Number(doc.id.slice(prefix.length).split("/")[0]);
			return Number.isSafeInteger(anchor) && anchor >= anchorSeq;
		});
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

	private blockedRows(
		target: string,
		scope: BlockedScope,
	): { operation_id: string; document_id: string }[] {
		const base = "SELECT operation_id, document_id FROM memory_outbox WHERE target = ? AND state = 'blocked'";
		return scope === undefined
			? this.db.query<{ operation_id: string; document_id: string }, [string]>(base).all(target)
			: this.db
					.query<{ operation_id: string; document_id: string }, [string, string | null]>(
						`${base} AND ${CAUSE_KEY} IS ?`,
					)
					.all(target, scope.error);
	}

	retryBlocked(target: string, scope?: BlockedScope): number {
		targetSchema.parse(target);
		const rows = this.blockedRows(target, scope);
		const retriedAt = Date.now();
		for (const row of rows) {
			const fresh = randomUUID();
			const change = this.db.run(
				`UPDATE memory_outbox SET operation_id = ?, state = 'pending', attempts = 0, next_attempt = 0, error = NULL,
				 retried_at = ?
				 WHERE operation_id = ? AND state = 'blocked'`,
				[fresh, retriedAt, row.operation_id],
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

	dismissBlocked(target: string, scope?: BlockedScope): number {
		targetSchema.parse(target);
		const rows = this.blockedRows(target, scope);
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
			.query<
				{
					document_id: string;
					error: string | null;
					attempts: number;
					conversation: string | null;
				},
				[string]
			>(
				`SELECT document_id, error, attempts, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.conversationId') END AS conversation
				 FROM memory_outbox WHERE target = ? AND state = 'blocked' ORDER BY rowid LIMIT 10`,
			)
			.all(target);
		return rows.map((r) => ({
			document: r.document_id.includes("/")
				? (r.document_id.split("/").pop() ?? r.document_id)
				: r.document_id,
			error: r.error === null ? null : r.error.slice(0, 120),
			attempts: r.attempts,
			conversationId: r.conversation,
		}));
	}

	blockedSummary(target: string): BlockedSummary {
		targetSchema.parse(target);
		const byConversation = this.db
			.query<{ conversationId: string | null; count: number }, [string]>(
				`SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.conversationId') END AS conversationId, COUNT(*) AS count
				 FROM memory_outbox WHERE target = ? AND state = 'blocked'
				 GROUP BY conversationId ORDER BY count DESC, conversationId LIMIT 100`,
			)
			.all(target);
		const causes = this.db
			.query<{ error: string | null; count: number; since: string | null }, [string]>(
				`SELECT ${CAUSE_KEY} AS error, COUNT(*) AS count,
				 MIN(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.timestamp') END) AS since
				 FROM memory_outbox WHERE target = ? AND state = 'blocked'
				 GROUP BY 1 ORDER BY count DESC LIMIT 20`,
			)
			.all(target);
		const byCause = causes.map((cause) => ({
			...cause,
			conversations: this.db
				.query<{ conversationId: string | null; count: number }, [string, string | null]>(
					`SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.conversationId') END AS conversationId, COUNT(*) AS count
					 FROM memory_outbox WHERE target = ? AND state = 'blocked' AND ${CAUSE_KEY} IS ?
					 GROUP BY conversationId ORDER BY count DESC, conversationId LIMIT 100`,
				)
				.all(target, cause.error),
		}));
		return {
			total: byConversation.reduce((n, g) => n + g.count, 0),
			byConversation,
			byCause,
		};
	}

	// ms timestamp of the newest completed retention, or null: rows
	// completed before settled_at existed carry no time.
	lastSaveAt(target: string): number | null {
		targetSchema.parse(target);
		const row = this.db
			.query<{ at: number | null }, [string]>(
				"SELECT MAX(settled_at) AS at FROM memory_outbox WHERE target = ? AND state = 'completed'",
			)
			.get(target);
		return row?.at ?? null;
	}

	retryProgress(target: string): RetryProgress | null {
		targetSchema.parse(target);
		const rows = this.db
			.query<
				{ state: string; conversationId: string | null; at: number; n: number },
				[string, string]
			>(
				`SELECT state, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.conversationId') END AS conversationId,
				 retried_at AS at, COUNT(*) AS n
				 FROM memory_outbox
				 WHERE target = ? AND retried_at = (SELECT MAX(retried_at) FROM memory_outbox WHERE target = ?)
				 GROUP BY state, conversationId`,
			)
			.all(target, target);
		const first = rows[0];
		if (first === undefined) return null;
		const out: RetryProgress = {
			startedAt: first.at,
			done: 0,
			queued: 0,
			failed: 0,
			conversations: [],
		};
		const byConversation = new Map<string | null, RetryProgress["conversations"][number]>();
		for (const r of rows) {
			const bucket =
				r.state === "completed"
					? "done"
					: r.state === "pending" || r.state === "submitted"
						? "queued"
						: r.state === "blocked"
							? "failed"
							: null;
			if (bucket === null) continue;
			out[bucket] += r.n;
			let entry = byConversation.get(r.conversationId);
			if (entry === undefined) {
				entry = { conversationId: r.conversationId, done: 0, queued: 0, failed: 0 };
				byConversation.set(r.conversationId, entry);
			}
			entry[bucket] += r.n;
		}
		if (out.done + out.queued + out.failed === 0) return null;
		out.conversations = [...byConversation.values()];
		return out;
	}

	recordRecall(ok: boolean, at: string): void {
		this.db.run(
			`INSERT INTO memory_recall_state (id, at, ok) VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET at = excluded.at, ok = excluded.ok`,
			[at, ok ? 1 : 0],
		);
	}

	lastRecall(): { at: string; ok: boolean } | null {
		const row = this.db
			.query<{ at: string; ok: number }, []>("SELECT at, ok FROM memory_recall_state WHERE id = 1")
			.get();
		return row === null ? null : { at: row.at, ok: row.ok === 1 };
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

function backoffMs(attempts: number): number {
	return Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 9));
}

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
			delayMs = backoffMs(item.attempts);
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
		if (state === "submitted") delayMs = backoffMs(item.attempts);
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
