/**
 * /cancel command response logic.
 *
 * `/cancel` is the sole interrupt-timing command: it aborts the in-flight
 * turn itself (via `interruptAndCascade`, called from its own handler in
 * `registry.ts`) and consumes the resulting `CascadeResult` to produce the
 * reply text. No other command interrupts — state-mutating commands queue
 * behind the turn instead.
 *
 * States:
 *   - nothing was running (no session AND no live subagents) → "Nothing to cancel."
 *   - something was running           → "Cancelled."
 *   - …with one or more timeouts      → appended honest suffix listing
 *     what didn't respond (the cascade stopped waiting; those things
 *     may still be alive — proposal non-goal: "no kill-9 fallback").
 *
 * Reply is computed from the cascade summary, not a pre-interrupt
 * snapshot, so the text is always consistent with what actually
 * happened. In particular, a `/cancel` sent without an active session
 * that nonetheless kills orphaned subagents still reports "Cancelled."
 * rather than lying with "Nothing to cancel."
 */

import type { CascadeResult } from "../interrupt.ts";

export interface CancelReplyArgs {
  hasSession: boolean;
  cascade: CascadeResult;
  /** Timeout used by the cascade, surfaced in the reply for context. */
  cascadeTimeoutMs: number;
}

export function cancelReply(args: CancelReplyArgs): string {
  const { attemptedMain, attemptedSubagents, wedgedMain } = args.cascade;
  // "Nothing to cancel." iff truly nothing was aborted — no main stream
  // AND no live subagents at cascade-start. If the cascade touched
  // anything, be honest about it regardless of session binding.
  if (!attemptedMain && attemptedSubagents === 0) return "Nothing to cancel.";
  if (wedgedMain) {
    return `The main agent is wedged after a previous abort timed out. Use /new or /archive to recover.${formatCascadeTimeoutSuffix(args.cascade, args.cascadeTimeoutMs)}`;
  }
  return `Cancelled.${formatCascadeTimeoutSuffix(args.cascade, args.cascadeTimeoutMs)}`;
}

/**
 * Honest-timeout suffix appended to `/cancel`'s reply. Returns "" when
 * nothing timed out, otherwise a leading-space suffix like
 * ` (the main agent and 2 subagents didn't respond in 5s and may still be running.)`
 * Only `/cancel` ever produces a cascade, so only `/cancel` ever appends this.
 */
export function formatCascadeTimeoutSuffix(
  cascade: CascadeResult,
  cascadeTimeoutMs: number,
): string {
  const { timedOutMain, timedOutSubagents } = cascade;
  if (!timedOutMain && timedOutSubagents === 0) return "";
  const seconds = Math.round(cascadeTimeoutMs / 1000);
  const stuck: string[] = [];
  if (timedOutMain) stuck.push("the main agent");
  if (timedOutSubagents > 0) {
    stuck.push(
      timedOutSubagents === 1 ? "1 subagent" : `${timedOutSubagents} subagents`,
    );
  }
  return ` (${stuck.join(" and ")} didn't respond in ${seconds}s and may still be running.)`;
}
