// The forgetting protocol's one owner (the /forget command and the mini
// app's button both land here): settle in-flight retention, then
// suppress → cancel → remote delete → redact. The order is load-bearing:
// a replace-mode retain accepted remotely and finishing after the delete
// would resurrect the document, and suppression must exist before
// anything else could re-enqueue.
//
// A queue row reading `pending` is not proof its retention was never
// sent — a submit can be accepted remotely while its acknowledgement is
// lost (timeout/5xx, or a crash before the submitted-state write). Every
// in-flight UUID is reconciled to terminal state, pending rows included,
// before any tracking is dropped or success reported; the durable
// operation UUID (persisted at enqueue, before any submit) is what makes
// that always possible (#86, #99).
//
// Reconciliation is per-destination (#87): rows bind to a one-way
// endpoint+bank target hash, so a previous bank's operation can only be
// settled through that bank's own client — the current client would read
// the new bank's bank-scoped 404 as settled. A destination nothing can
// address refuses the whole forget with every row preserved.
//
// No conversation fencing here (the command's own courtesy lives in
// commands.ts); cross-conversation recall-in-flight is a window already
// tolerated, and the protocol is re-runnable — suppression persists,
// deleteByDocument can run again.

import { HindsightError, identifier, type MemoryOperation } from "./hindsight.ts";
import { log } from "./log.ts";
import type { MemoryContexts } from "./memory.ts";
import type { MemoryQueue } from "./memory-queue.ts";

// `not_found` is already mapped to null by HindsightClient.operation.
const SETTLE_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SETTLE_POLL_MS = 1_000;
const SETTLE_BUDGET_MS = 30_000;

// True once every operation reached a terminal state — or was pruned
// server-side, null counts as settled — within the budget. False means
// still unsettled: the caller must refuse rather than race the delete.
// HindsightError retries inside the budget; anything else escapes loud.
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
	// (memory-destinations.ts) makes previous banks addressable. Without
	// it, a foreign-target row refuses the forget (never a foreign poll).
	clientForTarget?: (target: string) => HindsightInstance | null;
	contexts: MemoryContexts;
	queue: MemoryQueue;
	// Quiesce the retention worker around the delete; tests inject a
	// passthrough when no worker runs.
	withWorkerPaused: <T>(fn: () => Promise<T>) => Promise<T>;
	// Tests inject small values instead of sleeping the real budget.
	settleTiming?: { pollMs: number; budgetMs: number };
}

export type ForgetOutcome =
	| { outcome: "forgotten"; cancelled: number; redacted: number; settledOps: number }
	| { outcome: "busy"; unsettled: number }
	| { outcome: "foreign-bank"; target: string };

// Structural view of the client: operation(), deleteDocument(), and the
// target identity queue rows bind to.
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
	// Refuse a bad id before any local state (a suppression row) is written.
	const id = identifier.parse(documentId);
	const fields = { ...context, document: id };
	return source.withWorkerPaused(async () => {
		// The worker pause settled local HTTP, not Hindsight's remote async
		// processing; the settle loop covers that gap, pending rows too.
		const destinations = source.queue.documentDestinations(id);
		// Resolve every client BEFORE any settling: settling some banks
		// first would leave a half-finished protocol the refusal cannot
		// roll back.
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
		// Every outbox destination may hold the document, plus the current
		// one for the browsing surface — a 404 delete reads as success.
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
