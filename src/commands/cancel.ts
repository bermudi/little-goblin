/**
 * /cancel command response logic.
 *
 * The actual abort + cascade is performed by `interruptAndCascade`
 * (see `src/interrupt.ts`); this helper only computes the reply text.
 *
 * Three states:
 *   - no active session       → "Nothing to cancel."
 *   - idle (nothing running)  → "Nothing to cancel."
 *   - was streaming OR had live subagents → "Cancelled."
 *
 * Note: the tasks file frames this as a check on the main agent's
 * streaming state alone. We also count live subagents because the
 * cascade-cancel kills them too — saying "Nothing to cancel." while
 * actually killing 3 subagents would be a lie.
 */
export function cancelReply(args: {
  hasSession: boolean;
  wasStreaming: boolean;
  hadLiveSubagents: boolean;
}): string {
  if (!args.hasSession) return "Nothing to cancel.";
  if (args.wasStreaming || args.hadLiveSubagents) return "Cancelled.";
  return "Nothing to cancel.";
}
