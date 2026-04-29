/**
 * Parse a Telegram message into its command token, stripping the optional
 * `@botname` suffix that Telegram clients append in groups/topics.
 *
 * Examples:
 *   `/cancel`              → `/cancel`
 *   `/cancel arg`          → `/cancel`
 *   `/cancel@goblinbot`    → `/cancel`
 *   `/cancel@goblinbot x`  → `/cancel`
 *   `not-a-command`        → `null`
 */
export function parseCommand(rawText: string | undefined): string | null {
  if (!rawText || !rawText.startsWith("/")) return null;
  const head = rawText.split(" ")[0] ?? "";
  const stripped = head.split("@")[0] ?? "";
  return stripped === "" ? null : stripped;
}
