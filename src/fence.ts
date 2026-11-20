// The one way to move a conversation's epoch (#820). Bump and cancel are
// one call: `work` bumps through `bump` inside one store transaction, and
// once that transaction commits, every bumped lane is cancelled
// synchronously, before any other work can enter it. A rollback bumps and
// cancels nothing. Production code reaches it through `Runtime.fence`;
// `module-boundaries.test.ts` keeps bare store bumps out of every other
// production file, so no path can fence a turn without also ending it.
import type { ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";

/** Advances one conversation's epoch; `previousEpoch` floors a recreated row. */
export type Bump = (convId: string, previousEpoch?: number) => number;

/** The transaction committed; cancelling one or more fenced lanes threw. */
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
	// Inside an outer transaction "commit" is only a savepoint: the outer
	// could still roll the bump back after the turn was cancelled.
	if (store.db.inTransaction) throw new Error("an epoch fence must not run inside a transaction");
	const epochs = new Map<string, number>();
	const result = store.db.transaction(() =>
		work((convId, previousEpoch) => {
			const epoch = store.bumpEpoch(convId, previousEpoch);
			epochs.set(convId, epoch);
			return epoch;
		}),
	)();
	// Every fenced lane gets its cancellation — one lane's failure never
	// skips the rest.
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
