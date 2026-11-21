import type { ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";

export type Bump = (convId: string, previousEpoch?: number) => number;

export class FenceCancelError extends Error {
	constructor(
		readonly lanes: string[],
		cause: unknown,
	) {
		super(`epoch fence committed; cancelling ${lanes.join(", ")} failed`, { cause });
		this.name = "FenceCancelError";
	}
}

export function runFence<T, C>(
	store: Pick<ConversationStore, "db" | "bumpEpoch">,
	work: (bump: Bump) => T,
	cancel: (convId: string, epoch: number) => C,
): { result: T; cancelled: Map<string, C> } {
	if (store.db.inTransaction) throw new Error("an epoch fence must not run inside a transaction");
	const epochs = new Map<string, number>();
	const result = store.db.transaction(() =>
		work((convId, previousEpoch) => {
			const epoch = store.bumpEpoch(convId, previousEpoch);
			epochs.set(convId, epoch);
			return epoch;
		}),
	)();
	const cancelled = new Map<string, C>();
	const failed: string[] = [];
	let first: { error: unknown } | null = null;
	for (const [convId, epoch] of epochs) {
		try {
			cancelled.set(convId, cancel(convId, epoch));
		} catch (err) {
			failed.push(convId);
			first ??= { error: err };
			log.error("fence cancel failed", err, { conversation: convId, epoch });
		}
	}
	if (first !== null) throw new FenceCancelError(failed, first.error);
	return { result, cancelled };
}
