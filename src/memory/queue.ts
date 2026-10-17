// Durable retention outbox. Shares the conversation store's SQLite connection:
// enqueue inside the history append transaction, never after it.
import { type Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	HindsightClient,
	HindsightError,
	memoryDocumentSchema,
	targetHashSchema,
	type MemoryDocument,
} from "./hindsight.ts";
import { log } from "../log.ts";
import { screenMemoryText } from "./screen.ts";

// The destination-identity vocabulary lives in hindsight.ts; this local
// alias keeps the queue's validation reads the same as before.
const targetSchema = targetHashSchema;
export interface MemoryQueueCounts {
	pending: number;
	submitted: number;
	completed: number;
	blocked: number;
	dismissed: number;
	// Rows parked mid-forget: their destination's remote delete has not
	// confirmed yet (#113). Not worker work — never due in next().
	deleting: number;
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
	// `deleting`: forget parked the row. It is invisible to the worker
	// (never submitted or polled again) but survives as the
	// document→destination retry map until that destination's delete
	// confirms (#113).
	state: z.enum(["pending", "submitted", "completed", "blocked", "dismissed", "deleting"]),
	attempts: z.number().int().nonnegative(),
	next_attempt: z.number().int().nonnegative(),
	error: z.string().nullable(),
});
export type MemoryQueueItem = Omit<z.infer<typeof rowSchema>, "payload"> & {
	document: MemoryDocument;
};

export class MemoryQueue {
	// The one pending row whose submit is on the wire right now — process
	// local, because one worker owns the outbox and its ticks never
	// overlap. The worker flips a row to `submitted` only after submit()
	// returns, so a cancel that deletes this row mid-call leaves the
	// document retained remotely with no local row to forget it by; the
	// cancel is deferred instead and the worker settles it once the
	// request is answered (see cancelConversation / settleInflight).
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

	// A row the decoder rejects (schema drift, a hand edit, torn bytes)
	// is parked `blocked` with the decode error instead of thrown: a
	// throw from next() aborts every drain at the same row — nothing
	// behind it ever ships, nothing ever advances, and the only trace is
	// a tick error per interval. Blocked rows surface in /memory status
	// and answer to retry/dismiss like any other; addressed by rowid
	// because the row's own columns are what failed validation.
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

	// Due pending submissions outrank polling already-acknowledged
	// operations: a submitted row's poll is bookkeeping, while a due
	// pending row is unsent work. Ordering by rowid alone let an early
	// submitted row — re-polled at every backoff interval — continually
	// outrank every later enqueue. rowid still orders within each state,
	// so submitted rows poll FIFO among themselves.
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
				// Quarantine moves the row out of the due set; if it somehow
				// did not (a concurrent state change), the next pick is the
				// same row again — fail loud rather than spin.
				this.quarantine(raw, err);
				const again = query.get(target, now) as { rowid?: unknown } | null;
				if (again !== null && again.rowid === (raw as { rowid?: unknown }).rowid) throw err;
			}
		}
	}

	// Worker-only brackets around the submit HTTP call. settleInflight
	// reports whether a cancel arrived while the request was on the wire
	// — the worker finishes that cancel if the row is still pending, and
	// leaves an accepted row tracked through completion like any other
	// submitted operation.
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

	// The deferred half of cancelConversation: the row's submit settled
	// without an acceptance (retryable failure, or the request was
	// aborted), so it is still the unsent pending work the cancel
	// promised to purge. CAS on state + attempts, like update().
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

	// Forgetting's per-destination map: every target holding a row for
	// this document, with that target's in-flight operations. A queue
	// row reading `pending` is NOT proof its retention was never sent: a
	// submit can be accepted remotely while its acknowledgement degrades
	// (a retryable failure leaves the row pending), and a crash between
	// acceptance and the submitted-state write does the same — callers
	// reconcile both states through to terminal. Rows in every other
	// state — completed/blocked/dismissed, and `deleting` rows parked by
	// an earlier failed forget — keep their target listed with an empty
	// inflight list: all of them mean the destination may hold the
	// document, so forget must delete there too — through the owning
	// destination, never a foreign one (#87). First-seen rowid order for
	// determinism.
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

	// Forgetting parks every row for the document in `deleting` instead
	// of deleting it outright: the worker never selects that state, so
	// ingestion stops (suppression already blocks new enqueues), blocked
	// review surfaces stop offering the document, and the rows survive as
	// the only durable document→destination map. Releasing them before
	// the remote deletes confirmed would let a failed delete — or a crash
	// mid-protocol — strand retry with no way to know which banks still
	// hold the document (#113).
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

	// A destination's rows are released only after that destination's own
	// delete confirmed — until then they are the retry map. Safe to repeat
	// after a crash between delete and release: the re-delete reads as
	// success (a bank-scoped 404 included).
	confirmDeleted(documentId: string, target: string): number {
		targetSchema.parse(target);
		const change = this.db.run("DELETE FROM memory_outbox WHERE document_id = ? AND target = ?", [
			documentId,
			target,
		]);
		return Number(change.changes);
	}

	// Excluding a topic purges its pending retention — "/memory off"
	// promises no new submissions. Submitted operations were already
	// accepted remotely and must remain tracked through completion —
	// including the one whose submit is on the wire this instant: its
	// row still reads pending, so it is skipped here and settled by the
	// worker (accepted → tracked like any submitted row; unsent →
	// dropped then). Finished, blocked, and other topics' rows are
	// untouched; an undecodable row is quarantined, never a throw that
	// leaves the exclusion applied with the purge half done.
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

	// Outstanding forget work across ALL destinations: parked `deleting`
	// rows are bound to the bank that owns them, so after a destination
	// change the current bank's counts() reads zero while an old bank
	// still holds the document. Status reads this seam, never the
	// per-target counts, so a failed old-bank delete stays visible.
	deletingCount(): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM memory_outbox WHERE state = 'deleting'")
			.get() as {
			n: number;
		};
		return row.n;
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
		// A cancel that arrives while the submit is on the wire is deferred
		// by the queue; once the request settles without an acceptance the
		// row is still the unsent work that cancel promised to purge.
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
			if (err.kind === "cancelled") {
				// Keep the durable row for restart — unless its topic was
				// excluded meanwhile: an aborted submit is unsent work, and a
				// restart must not ship it behind the exclusion.
				if (cancelRequested) this.queue.dropCancelled(item);
				return false;
			}
			state = err.retryable ? item.state : "blocked";
			delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(item.attempts, 9));
			error = err.message; // HindsightError is deliberately payload-free.
			transportFailure = err.retryable;
		}
		if (cancelRequested && state === "pending" && this.queue.dropCancelled(item)) {
			// The deferred cancel, finished: the submit failed retryably, so
			// the row would otherwise come due again behind "/memory off".
			if (transportFailure)
				this.observe?.({
					ok: false,
					transport: true,
					conversationId: item.document.conversationId,
				});
			return true;
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
