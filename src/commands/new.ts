/**
 * /new command logic.
 *
 * `/new` is the universal "switch this chat to a fresh session"
 * command. It works in DMs, forum topics, and supergroups: create a
 * fresh session bound to the same chat surface. The previous session is
 * left resumable; `/archive` is the explicit "put this away" command.
 *
 * Side effects (creating the session, binding it, registering an
 * `AgentRunner`) live in `bot.ts`; this helper only orchestrates the
 * operation and produces the reply text. Keeping side effects injectable
 * keeps the test surface trivial.
 *
 * Interrupt + cascade-cancel for an active stream happens *before* this
 * helper runs (see `interruptAndCascade` in `src/interrupt.ts`); /new
 * is registered in `CANCEL_CAPABLE_COMMANDS`.
 */

import type { SessionState } from "../sessions/types.ts";

export interface NewCommandDeps {
  /** Caller-supplied session factory. */
  createSession: () => SessionState;
}

export type NewCommandResult = {
  kind: "created";
  session: SessionState;
  reply: string;
};

export function createdReply(sessionId: string): string {
  return `Created new session \`${sessionId}\``;
}

export function executeNew(deps: NewCommandDeps): NewCommandResult {
  const session = deps.createSession();
  return {
    kind: "created",
    session,
    reply: createdReply(session.id),
  };
}
