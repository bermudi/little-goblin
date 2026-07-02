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

/**
 * Extract a command's argument string from raw Telegram text, stripping the
 * `/command` prefix AND any `@botname` suffix Telegram appends in groups.
 * Returns `""` when the message has no argument. Leading/trailing whitespace
 * is trimmed.
 *
 * This is the single source of truth for argument extraction — commands use
 * it instead of each hand-rolling a `replace(/^\/foo(?:@\S+)?\s+/, ...)`
 * regex, which is how the `@bot` suffix got dropped in four places.
 *
 * Examples:
 *   `/model 2`                     → `"2"`
 *   `/model@bermudi_little_goblin_bot`     → `""`
 *   `/model@bermudi_little_goblin_bot 2`   → `"2"`
 *   `/project ~/foo`               → `"~/foo"`
 *   `/project@bot ~/foo bar`       → `"~/foo bar"`   (internal spaces kept)
 *   `/model`                       → `""`
 *   `/cancel`                      → `""`
 */
export function parseCommandArg(rawText: string): string {
  // Find the first whitespace boundary; everything after it is the argument.
  const firstSpace = rawText.search(/\s/u);
  if (firstSpace === -1) return "";
  return rawText.slice(firstSpace).trim();
}

