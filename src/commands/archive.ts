/**
 * /archive command logic.
 *
 * Side effects (renaming the topic, dropping the runner from the bot's
 * runner map) live in `bot.ts`; this helper decides what should happen
 * and produces the reply text. The actual filesystem move + binding
 * cleanup is `ConversationLifecycle.archive`, injected as `archive`.
 *
 * `/archive` is a queue-timing command: if a turn is in flight, it defers
 * behind it (so the runner is idle and the transcript writer is quiescent)
 * before this helper runs. See `CommandTiming` in `registry.ts`.
 */

import type { ArchiveTransition } from "../orchestration/conversation-lifecycle.ts";

export interface ArchiveCommandDeps {
  /** Performs the lifecycle-owned archive and returns the status transition. */
  archive: () => Promise<ArchiveTransition>;
}

export type ArchiveCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "archived"; reply: string };

export const NO_SESSION_REPLY = "No active conversation to archive.";
export const ARCHIVED_REPLY = "Conversation archived.";

export async function executeArchive(deps: ArchiveCommandDeps): Promise<ArchiveCommandResult> {
  const transition = await deps.archive();
  if (transition.kind === "no-session") {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }
  return { kind: "archived", reply: ARCHIVED_REPLY };
}
