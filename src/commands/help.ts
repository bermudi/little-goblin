/**
 * /help command response.
 *
 * The spec requires `/help` to list every available command. We render
 * a stable, alphabetically-grouped (by category) plain-text reply so it
 * is easy to scan in Telegram and easy to assert against in tests.
 *
 * Stub commands (`/subagents`, `/cancel_subagent`, `/revive`) are
 * included in the listing — the surface exists today even if the
 * behaviour lives in `subagent-runtime`. Their description hints that
 * they are not yet implemented so the user is not surprised by a
 * "Not implemented" reply.
 */
export const HELP_REPLY = [
  "Commands:",
  "/cancel — abort the current turn (cascades to subagents)",
  "/new — start a fresh DM session (no-op in topics)",
  "/archive — archive the active session",
  "/debug — dump session diagnostics",
  "/subagents — list live subagents (not implemented yet)",
  "/cancel_subagent <id> — cancel a single subagent (not implemented yet)",
  "/revive <id> — revive an archived subagent (not implemented yet)",
  "/help — show this list",
].join("\n");
