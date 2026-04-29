/**
 * /new command logic.
 *
 * Side effects (creating the session, binding it, registering an
 * `AgentRunner`) live in `bot.ts`; this helper only decides what the
 * command should do and what reply text to produce. Keeping the side
 * effect injectable keeps the test surface trivial.
 *
 * Two cases:
 *   - in a forum topic → topics are already their own session, refuse
 *   - elsewhere (DM / supergroup-no-topic / no active session) → create
 *     a new session via `createSession` and report the new id
 *
 * Interrupt + cascade-cancel for an active stream happens *before* this
 * helper runs (see `interruptAndCascade` in `src/interrupt.ts`); /new
 * is registered in `CANCEL_CAPABLE_COMMANDS`.
 */

import type { SessionState } from "../sessions/types.ts";

export interface NewCommandDeps {
  /** True iff the message originated in a forum topic (`locator.topicId !== undefined`). */
  hasTopic: boolean;
  /** Caller-supplied session factory. Only invoked in the create branch. */
  createSession: () => SessionState;
}

export type NewCommandResult =
  | { kind: "topic-rejected"; reply: string }
  | { kind: "created"; session: SessionState; reply: string };

export const TOPIC_REJECTED_REPLY =
  "This topic is already its own session. No need for /new here.";

export function createdReply(sessionId: string): string {
  return `Created new session \`${sessionId}\``;
}

export function executeNew(deps: NewCommandDeps): NewCommandResult {
  if (deps.hasTopic) {
    return { kind: "topic-rejected", reply: TOPIC_REJECTED_REPLY };
  }
  const session = deps.createSession();
  return {
    kind: "created",
    session,
    reply: createdReply(session.id),
  };
}
