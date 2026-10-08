// The forgetting protocol's one owner: reconcile in-flight retention,
// then suppress → cancel → remote delete → redact. Both surfaces — the
// /forget delete command and the mini app's forget button — call this;
// neither re-implements the order. The order is load-bearing: a
// replace-mode retain accepted remotely finishing after the delete would
// resurrect the document (unpaused delete), and suppression must exist
// before anything else could re-enqueue. Fail-loud: Hindsight and store
// errors propagate; only the settle-budget refusal is an expected
// outcome (the caller tells the operator to retry).
//
// A queue row reading `pending` is not proof its retention was never
// sent: the worker's submit can be accepted remotely while its
// acknowledgement degrades (a retryable timeout/5xx leaves the row
// pending), and a crash between acceptance and the submitted-state
// write does the same — attempts=0 is no proof either. Every in-flight
// UUID is therefore reconciled through to terminal state, pending rows
// included, before any tracking is dropped or success reported; the
// durable operation UUID (persisted at enqueue, before any submit) is
// what makes the reconciliation always possible (#86, #99).
//
// No conversation fencing here: /forget fences the conversation it was
// typed in (its own courtesy, kept in commands.ts); the mini app has no
// conversation. Cross-conversation recall-in-flight is a window the
// command already tolerates — same tolerance here, re-runnable
// (suppression persists; deleteByDocument can run again).

import { HindsightError, identifier, type MemoryOperation } from "./hindsight.ts";
import { log } from "./log.ts";
import type { MemoryContexts } from "./memory.ts";
import type { MemoryQueue } from "./memory-queue.ts";

// `not_found` is already mapped to null by HindsightClient.operation.
const SETTLE_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SETTLE_POLL_MS = 1_000;
const SETTLE_BUDGET_MS = 30_000;

// True once every operation reached a terminal state (or was pruned
// server-side — null counts as settled) within the budget; false means
// something is still unsettled and the caller must refuse rather than
// race the delete. Transient Hindsight failures retry inside the same
// budget (each poll logs its own request line); anything that is not a
// HindsightError escapes so the forget attempt fails loud.
async function settleInflightRetention(
	client: HindsightInstance,
	operationIds: string[],
	timing?: { pollMs?: number; budgetMs?: number },
): Promise<boolean> {
	const pollMs = timing?.pollMs ?? SETTLE_POLL_MS;
	const deadline = Date.now() + (timing?.budgetMs ?? SETTLE_BUDGET_MS);
	const outstanding = new Set(operationIds);
	while (outstanding.size > 0 && Date.now() < deadline) {
		for (const operationId of [...outstanding]) {
			try {
				const operation = await client.operation(operationId);
				if (operation === null || SETTLE_TERMINAL.has(operation.status))
					outstanding.delete(operationId);
			} catch (err) {
				if (!(err instanceof HindsightError)) throw err;
			}
		}
		if (outstanding.size > 0) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
		}
	}
	return outstanding.size === 0;
}

export interface ForgetSource {
	client: HindsightInstance;
	contexts: MemoryContexts;
	queue: MemoryQueue;
	// Quiesce the retention worker around the delete (see
	// MemoryWorker.withWorkerPaused) — wired from the boot worker in
	// index.ts; tests inject a passthrough when no worker runs.
	withWorkerPaused: <T>(fn: () => Promise<T>) => Promise<T>;
	// Production omits it and gets the defaults; tests inject small
	// values instead of sleeping the real budget (same ruling as
	// MemoryQueueWorker's injectable clock).
	settleTiming?: { pollMs: number; budgetMs: number };
}

export type ForgetOutcome =
	| { outcome: "forgotten"; cancelled: number; redacted: number; settledOps: number }
	| { outcome: "busy"; unsettled: number };

// Structural view of the client — the forget protocol only needs
// operation() and deleteDocument(); tests can stub it.
export interface HindsightInstance {
	operation(operationId: string, signal?: AbortSignal): Promise<MemoryOperation | null>;
	deleteDocument(documentId: string, signal?: AbortSignal): Promise<void>;
}

// Channel and, when known, the conversation the request came from —
// merged into every log line so goblin.log reconstructs who forgot what.
export interface ForgetContext {
	channel: "telegram" | "mini-app";
	conversation?: string;
}

export async function forgetDocument(
	source: ForgetSource,
	documentId: string,
	context: ForgetContext,
): Promise<ForgetOutcome> {
	// Same vocabulary the client enforces on real ids — refuse a bad id
	// before any local state (a suppression row) is written.
	const id = identifier.parse(documentId);
	const fields = { ...context, document: id };
	return source.withWorkerPaused(async () => {
		// Pending rows are reconciled like submitted ones: their submit
		// may already be accepted remotely with the acknowledgement lost
		// (or crashed before the submitted-state write), and only the poll
		// can tell the difference — a pending UUID absent remotely settles
		// on its first poll, an accepted one waits out like any submitted
		// operation. The worker pause settled local HTTP work, not remote
		// async processing; this loop is what covers that gap.
		const inflight = source.queue.inflightOps(id);
		const operationIds = inflight.map((op) => op.operationId);
		let settledOps = 0;
		if (operationIds.length > 0) {
			const startedAt = Date.now();
			if (!(await settleInflightRetention(source.client, operationIds, source.settleTiming))) {
				log.warn("forget refused — retention still processing remotely", {
					...fields,
					operations: operationIds.length,
				});
				return { outcome: "busy", unsettled: operationIds.length };
			}
			settledOps = operationIds.length;
			log.info("forget settled in-flight retention", {
				...fields,
				operations: operationIds.length,
				pending: inflight.filter((op) => op.state === "pending").length,
				waitedMs: Date.now() - startedAt,
			});
		}
		source.contexts.suppress(id);
		const cancelled = source.queue.cancelDocument(id);
		await source.client.deleteDocument(id);
		const redacted = source.contexts.deleteByDocument(id);
		log.info("memory forgotten", {
			...fields,
			cancelled,
			redacted,
			settledOps,
			prefixReset: true,
		});
		return { outcome: "forgotten", cancelled, redacted, settledOps };
	});
}
