import type { ConversationStore } from "../conversation.ts";
import { type Bump, runFence } from "../fence.ts";

export function storeFence(
	store: Pick<ConversationStore, "db" | "bumpEpoch">,
	cancel: (convId: string, epoch: number) => void = () => {},
): <T>(work: (bump: Bump) => T) => T {
	return (work) => runFence(store, work, cancel).result;
}
