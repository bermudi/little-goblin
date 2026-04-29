/**
 * Subagent command surface — surface-only stubs.
 *
 * `/subagents`, `/cancel_subagent <id>`, `/revive <id>` are command
 * surfaces defined in `session-commands-cancel`. Their actual behaviour
 * (listing, cancelling, reviving) is implemented in the
 * `subagent-runtime` change. Until then, these helpers parse the
 * command line and return the canonical "Not implemented" stub reply
 * mandated by the spec.
 *
 * Parsing lives here (not inline in `bot.ts`) so the argument shape is
 * unit-testable and the eventual real implementation has a stable
 * call-site to grow into.
 */
export const SUBAGENT_STUB_REPLY = "Not implemented";

/**
 * Pull the first whitespace-separated argument off a slash-command line.
 *
 * Returns null if no argument was supplied. The leading `/<command>`
 * token is dropped; everything else is ignored — these are stubs.
 */
export function parseSubagentId(rawText: string): string | null {
  const parts = rawText.trim().split(/\s+/);
  const arg = parts[1];
  return arg && arg.length > 0 ? arg : null;
}
