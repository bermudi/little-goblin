// The forgetting protocol's one owner: reconcile in-flight retention,
// then suppress → cancel → remote delete → redact. Both surfaces — the
// /forget delete command and the mini app's forget button — call this;
// neither re-implements the order. The order is load-bearing: a
// replace-mode retain accepted remotely finishing after the delete would
// resurrect the document (unpaused delete), and suppression must exist
// before anything else could re-enqueue. Fail-loud: Hindsight and store
// errors propagate; the settle-budget refusal and the unaddressable-
// destination refusal are the expected outcomes (the caller tells the
// operator to retry or reconcile).
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
// The reconciliation is per-destination (#87): rows bind to the
// endpoint+bank target hash, and that hash is one-way — an operation
// accepted by a PREVIOUS bank can never be reconciled through the
// current client (the new bank's bank-scoped 404 reads as settled).
// Each destination named by the outbox is settled and deleted through
// its own client — reconstructed from destination history — and the
// current destination is always deleted. A destination nothing can
// address refuses the whole forget with every row preserved; old-bank
// rows are never silently cancelled on a new-bank delete.
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
	// Reconstruct the client owning a queue target — destination history
	// (memory-destinations.ts) makes previous banks addressable after a
	// config change. Optional only so partial wirings compile: without it,
	// any foreign-target row refuses the forget (never a foreign poll).
	clientForTarget?: (target: string) => HindsightInstance | null;
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
	| { outcome: "busy"; unsettled: number }
	| { outcome: "foreign-bank"; target: string };

// Structural view of the client — the forget protocol needs
// operation(), deleteDocument(), and the target identity rows bind to;
// tests can stub the rest away.
export interface HindsightInstance {
	readonly target: string;
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
		// async processing; the settle loop covers that gap.
		const destinations = source.queue.documentDestinations(id);
		// Resolve every destination's client BEFORE any settling: an
		// old-bank row can only be reconciled through the old bank's own
		// client, and a destination nothing can address must refuse the
		// whole forget up front — settling some banks first would leave a
		// half-finished protocol the refusal cannot roll back.
		const clients = new Map<string, HindsightInstance>();
		for (const destination of destinations) {
			if (destination.target === source.client.target) {
				clients.set(destination.target, source.client);
				continue;
			}
			const foreign = source.clientForTarget?.(destination.target) ?? null;
			if (foreign === null) {
				log.warn("forget refused — previous memory bank not addressable", {
					...fields,
					target: destination.target,
				});
				return { outcome: "foreign-bank", target: destination.target };
			}
			clients.set(destination.target, foreign);
		}
		let settledOps = 0;
		for (const destination of destinations) {
			if (destination.inflight.length === 0) continue;
			const operationIds = destination.inflight.map((op) => op.operationId);
			const startedAt = Date.now();
			if (
				!(await settleInflightRetention(
					clients.get(destination.target)!,
					operationIds,
					source.settleTiming,
				))
			) {
				log.warn("forget refused — retention still processing remotely", {
					...fields,
					target: destination.target,
					operations: operationIds.length,
				});
				return { outcome: "busy", unsettled: operationIds.length };
			}
			settledOps += operationIds.length;
			log.info("forget settled in-flight retention", {
				...fields,
				target: destination.target,
				operations: operationIds.length,
				pending: destination.inflight.filter((op) => op.state === "pending").length,
				waitedMs: Date.now() - startedAt,
			});
		}
		source.contexts.suppress(id);
		const cancelled = source.queue.cancelDocument(id);
		// Delete through every destination the outbox names — a completed
		// or blocked row means its bank may hold the document — plus the
		// current one (the browsing surface's view; harmless when absent:
		// a 404 delete reads as success).
		for (const destination of destinations) {
			if (destination.target === source.client.target) continue;
			await clients.get(destination.target)!.deleteDocument(id);
		}
		await source.client.deleteDocument(id);
		const redacted = source.contexts.deleteByDocument(id);
		log.info("memory forgotten", {
			...fields,
			cancelled,
			redacted,
			settledOps,
			destinations: clients.size,
			prefixReset: true,
		});
		return { outcome: "forgotten", cancelled, redacted, settledOps };
	});
}
