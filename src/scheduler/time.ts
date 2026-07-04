/**
 * Pure parsers and formatters for the bounded time grammar used by
 * `/schedule`.
 *
 * The grammar is deliberately tiny (see design decision "Use bounded explicit
 * time grammar"):
 *   - durations: integer + unit, e.g. `30m`, `2h`, `1d`
 *   - `at <ISO-8601 datetime>`: absolute one-shot, e.g. `2026-07-05T09:00:00Z`
 *   - `in <duration>`: relative one-shot, e.g. `in 30m`
 *
 * Parse functions that can fail return a discriminated result so the command
 * layer can map each failure to a specific usage reply without re-parsing.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export type DurationUnit = "m" | "h" | "d";

/** Durations must be a positive integer followed by a single unit. */
const DURATION_RE = /^(\d+)(m|h|d)$/;

/**
 * Parse a duration string (`30m`, `2h`, `1d`) into milliseconds.
 * Returns null for invalid input or non-positive values (a `0m` schedule
 * would be meaningless and a `0m` recurring schedule would tight-loop).
 */
export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  const unit = match[2] as DurationUnit;
  switch (unit) {
    case "m":
      return value * MS_PER_MINUTE;
    case "h":
      return value * MS_PER_HOUR;
    case "d":
      return value * MS_PER_DAY;
  }
}

export type ParseAtResult =
  | { ok: true; ms: number }
  | { ok: false; reason: "invalid" | "past" };

/**
 * Parse an absolute ISO-8601 datetime for `/schedule at`. Rejects invalid
 * strings and timestamps at or before `now`. Requires a `T` separator so
 * bare dates or engine-lenient non-ISO inputs are rejected — the documented
 * form is a full ISO-8601 datetime such as `2026-07-05T09:00:00Z`.
 */
export function parseAt(input: string, now: number): ParseAtResult {
  const trimmed = input.trim();
  // Require datetime form (contains "T"). Date-only ISO is valid but not part
  // of the documented v1 grammar.
  if (!trimmed.includes("T")) return { ok: false, reason: "invalid" };
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return { ok: false, reason: "invalid" };
  if (ms <= now) return { ok: false, reason: "past" };
  return { ok: true, ms };
}

export type ParseInResult =
  | { ok: true; ms: number }
  | { ok: false; reason: "invalid" };

/**
 * Parse `/schedule in <duration>` into an absolute epoch ms (now + duration).
 * Always future-valued because a positive duration is added to `now`.
 */
export function parseIn(input: string, now: number): ParseInResult {
  const duration = parseDuration(input);
  if (duration === null) return { ok: false, reason: "invalid" };
  return { ok: true, ms: now + duration };
}

/**
 * Format a millisecond duration back into the canonical short form, choosing
 * the largest unit that divides it evenly: `1d`, `2h`, `30m`. Falls back to
 * minutes for non-clean values. Returns `${n}${unit}` matching the input
 * grammar.
 */
export function formatDuration(ms: number): string {
  if (ms % MS_PER_DAY === 0) return `${ms / MS_PER_DAY}d`;
  if (ms % MS_PER_HOUR === 0) return `${ms / MS_PER_HOUR}h`;
  const minutes = Math.round(ms / MS_PER_MINUTE);
  return `${minutes}m`;
}

/**
 * Format an epoch ms value as an ISO-8601 string for reply display.
 */
export function formatRunTime(ms: number): string {
  return new Date(ms).toISOString();
}
