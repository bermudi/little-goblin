/**
 * /new command logic.
 *
 * `/new` is the universal "reset this chat" command. It works in DMs,
 * forum topics, and supergroups: archive the prior session if one
 * exists, then create a fresh session bound to the same chat surface.
 *
 * Side effects (archiving, creating the session, binding it, registering
 * an `AgentRunner`, renaming topics) live in `bot.ts`; this helper only
 * orchestrates the order and produces the reply text. Keeping side
 * effects injectable keeps the test surface trivial.
 *
 * Interrupt + cascade-cancel for an active stream happens *before* this
 * helper runs (see `interruptAndCascade` in `src/interrupt.ts`); /new
 * is registered in `CANCEL_CAPABLE_COMMANDS`.
 */

import type { SessionState } from "../sessions/types.ts";

export interface NewCommandDeps {
  /**
   * Best-effort archive of any prior session bound to this chat.
   * Called before `createSession` when provided. Omit when there is no
   * prior session to archive (fresh DM with no binding). If this throws,
   * `executeNew` propagates without calling `createSession` — the caller
   * is expected to catch and surface a friendly reply.
   */
  archivePrior?: () => void;
  /** Caller-supplied session factory. */
  createSession: () => SessionState;
}

export type NewCommandResult = {
  kind: "created";
  session: SessionState;
  archivedPrior: boolean;
  reply: string;
};

export function createdReply(sessionId: string): string {
  return `Created new session \`${sessionId}\``;
}

export function executeNew(deps: NewCommandDeps): NewCommandResult {
  const archivedPrior = deps.archivePrior !== undefined;
  if (deps.archivePrior) deps.archivePrior();
  const session = deps.createSession();
  return {
    kind: "created",
    session,
    archivedPrior,
    reply: createdReply(session.id),
  };
}
