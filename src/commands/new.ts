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
 * `/new` is a queue-timing command: if a turn is in flight, it defers
 * behind it (so the runner is idle and the prior session's transcript is
 * complete) before this helper runs. See `CommandTiming` in `registry.ts`.
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
