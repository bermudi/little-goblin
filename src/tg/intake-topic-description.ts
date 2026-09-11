import { log } from "../log.ts";
import { completed, type AdmissionResult } from "../shutdown/mod.ts";
import type { IntakeDeps } from "./intake-turn.ts";

export function createTopicDescriptionHandler(deps: IntakeDeps) {
  return async function handleTopicDescription(
    chatId: number | undefined,
    topicId: number | undefined,
    name: string | undefined,
  ): Promise<AdmissionResult<void>> {
    if (chatId === undefined || topicId === undefined || name === undefined) {
      return completed(undefined);
    }
    try {
      await deps.memoryStore.setDescription(
        { topic: { chatId, topicId } },
        name,
      );
    } catch (err) {
      log.warn("failed to set topic description", {
        chatId,
        topicId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return completed(undefined);
  };
}
