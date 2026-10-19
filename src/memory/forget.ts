import { log } from "../log.ts";
import { HindsightError, identifier, type MemoryOperation } from "./hindsight.ts";
import type { MemoryContexts } from "./mod.ts";
import type { MemoryQueue } from "./queue.ts";

const SETTLE_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SETTLE_POLL_MS = 1_000;
const SETTLE_BUDGET_MS = 30_000;

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
	clientForTarget?: (target: string) => HindsightInstance | null;
	contexts: MemoryContexts;
	queue: MemoryQueue;
	withWorkerPaused: <T>(fn: () => Promise<T>) => Promise<T>;
	settleTiming?: { pollMs: number; budgetMs: number };
}

export type ForgetOutcome =
	| { outcome: "forgotten"; cancelled: number; redacted: number; settledOps: number }
	| { outcome: "busy"; unsettled: number }
	| { outcome: "foreign-bank"; target: string };

export interface HindsightInstance {
	readonly target: string;
	operation(operationId: string, signal?: AbortSignal): Promise<MemoryOperation | null>;
	deleteDocument(documentId: string, signal?: AbortSignal): Promise<void>;
}

export interface ForgetContext {
	channel: "telegram" | "mini-app" | "app";
	conversation?: string;
}

export async function forgetDocument(
	source: ForgetSource,
	documentId: string,
	context: ForgetContext,
): Promise<ForgetOutcome> {
	const id = identifier.parse(documentId);
	const fields = { ...context, document: id };
	return source.withWorkerPaused(async () => {
		const destinations = source.queue.documentDestinations(id);
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
		source.queue.markDocumentDeleting(id);
		let cancelled = 0;
		for (const destination of destinations) {
			if (destination.target === source.client.target) continue;
			await clients.get(destination.target)!.deleteDocument(id);
			cancelled += source.queue.confirmDeleted(id, destination.target);
		}
		await source.client.deleteDocument(id);
		cancelled += source.queue.confirmDeleted(id, source.client.target);
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
