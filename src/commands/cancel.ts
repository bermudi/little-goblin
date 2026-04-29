/**
 * /cancel command response logic.
 *
 * The actual abort + cascade is performed by `interruptAndCascade`
 * (see `src/interrupt.ts`); this helper consumes its `CascadeResult`
 * and produces the reply text.
 *
 * States:
 *   - no active session              → "Nothing to cancel."
 *   - nothing was running            → "Nothing to cancel."
 *   - something was running          → "Cancelled."
 *   - …with one or more timeouts     → appended honest suffix listing
 *     what didn't respond (the cascade stopped waiting; those things
 *     may still be alive — proposal non-goal: "no kill-9 fallback").
 *
 * Reply is computed from the cascade summary, not a pre-interrupt
 * snapshot, so the text is always consistent with what actually
 * happened.
 */

import type { CascadeResult } from "../interrupt.ts";

export interface CancelReplyArgs {
  hasSession: boolean;
  cascade: CascadeResult;
  /** Timeout used by the cascade, surfaced in the reply for context. */
  cascadeTimeoutMs: number;
}

export function cancelReply(args: CancelReplyArgs): string {
  if (!args.hasSession) return "Nothing to cancel.";
  const { attemptedMain, attemptedSubagents, timedOutMain, timedOutSubagents } = args.cascade;
  if (!attemptedMain && attemptedSubagents === 0) return "Nothing to cancel.";

  const seconds = Math.round(args.cascadeTimeoutMs / 1000);
  const stuck: string[] = [];
  if (timedOutMain) stuck.push("the main agent");
  if (timedOutSubagents > 0) {
    stuck.push(
      timedOutSubagents === 1 ? "1 subagent" : `${timedOutSubagents} subagents`,
    );
  }
  if (stuck.length === 0) return "Cancelled.";
  return `Cancelled. (${stuck.join(" and ")} didn't respond in ${seconds}s and may still be running.)`;
}
