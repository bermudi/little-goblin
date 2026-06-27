/**
 * /help command response.
 *
 * The spec requires `/help` to list every available command. We render
 * a stable, alphabetically-grouped (by category) plain-text reply so it
 * is easy to scan in Telegram and easy to assert against in tests.
 *
 * Subagent commands are backed by the runtime and expose the in-memory
 * runner surface for listing, cancellation, and revival.
 */
export const HELP_REPLY = [
  "Commands:",
  "/cancel — abort the current turn (cascades to subagents)",
  "/new — reset this chat: archive the current session and start a fresh one",
  "/archive — archive the active session",
  "/project <dir> — bind session to a project directory (or clear with /project)",
  "/model [index] — list favorite models or switch to one",
  "/compact [instructions] — manually compact this session's context",
  "/queue <text> — enqueue text to run as a fresh turn after the current one settles",
  "/debug — dump session diagnostics",
  "/think [level] — show or set thinking level",
  "/name <name> — name the active session",
  "/resume <id-or-name> — bind this chat to an existing session",
  "/voice — convert the last assistant message to a voice note",
  "/ping — smoke-test: reply with pong and chat info",
  "/start — start a new session (DMs only)",
  "/subagents — list tracked subagents",
  "/cancel_subagent <id> — cancel a single subagent",
  "/revive <id> <prompt> — revive a persisted subagent with a follow-up prompt",
  "/help — show this list",
].join("\n");
