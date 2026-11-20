// Runtime.fence for rigs without a Runtime: the real fence transaction
// over the store, with `cancel` standing in for the runtime's lane
// cancellation (a no-op by default — such rigs run no turns).
import type { ConversationStore } from "../conversation.ts";
import { type Bump, runFence } from "../fence.ts";

export function storeFence(
	store: Pick<ConversationStore, "db" | "bumpEpoch">,
	cancel: (convId: string, epoch: number) => void = () => {},
): <T>(work: (bump: Bump) => T) => T {
	return (work) => runFence(store, work, cancel).result;
}
