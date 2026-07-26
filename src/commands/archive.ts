/**
 * /archive command logic.
 *
 * Side effects (renaming the topic, dropping the runner from the bot's
 * runner map) live in `bot.ts`; this helper decides what should happen
 * and produces the reply text. The actual filesystem move + binding
 * cleanup is `ConversationLifecycle.archive`, injected as `archive`.
 *
 * Three branches:
 *   - no active conversation              → "No active conversation to archive."
 *   - conversation exists in bindings but
 *     `sessions/<id>/` is gone            → "Conversation already archived."
 *   - normal path                         → call archive(), reply success
 *
 * `/archive` is a queue-timing command: if a turn is in flight, it defers
 * behind it (so the runner is idle and the transcript writer is quiescent)
 * before this helper runs. See `CommandTiming` in `registry.ts`.
 */

export interface ArchiveCommandDeps {
  /** True iff a session was resolvable for this chat (DM/topic/supergroup). */
  hasSession: boolean;
  /** True iff `sessions/<id>/` still exists on disk. */
  sessionExists: boolean;
  /** Performs the actual archive. Only invoked on the normal path. */
  archive: () => void | Promise<void>;
}

export type ArchiveCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "already-archived"; reply: string }
  | { kind: "archived"; reply: string };

export const NO_SESSION_REPLY = "No active conversation to archive.";
export const ALREADY_ARCHIVED_REPLY = "Conversation already archived.";
export const ARCHIVED_REPLY = "Conversation archived.";

export async function executeArchive(deps: ArchiveCommandDeps): Promise<ArchiveCommandResult> {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }
  if (!deps.sessionExists) {
    return { kind: "already-archived", reply: ALREADY_ARCHIVED_REPLY };
  }
  await deps.archive();
  return { kind: "archived", reply: ARCHIVED_REPLY };
}
