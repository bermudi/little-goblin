import { describe, it, expect } from "bun:test";
import {
  parseDuration,
  parseAt,
  parseIn,
  formatDuration,
  formatRunTime,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
} from "./time.ts";

const NOW = Date.parse("2026-07-04T12:00:00Z");

describe("parseDuration", () => {
  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(30 * MS_PER_MINUTE);
  });

  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(2 * MS_PER_HOUR);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(MS_PER_DAY);
  });

  it("parses multi-digit values", () => {
    expect(parseDuration("120m")).toBe(120 * MS_PER_MINUTE);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDuration("  30m  ")).toBe(30 * MS_PER_MINUTE);
  });

  it("rejects zero duration", () => {
    expect(parseDuration("0m")).toBeNull();
  });

  it("rejects negative values", () => {
    expect(parseDuration("-5m")).toBeNull();
  });

  it("rejects fractional values", () => {
    expect(parseDuration("1.5h")).toBeNull();
  });

  it("rejects unknown units", () => {
    expect(parseDuration("5s")).toBeNull();
    expect(parseDuration("5w")).toBeNull();
  });

  it("rejects missing unit", () => {
    expect(parseDuration("30")).toBeNull();
  });

  it("rejects natural language", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("in a bit")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseDuration("")).toBeNull();
  });
});

describe("parseAt", () => {
  it("parses a valid future ISO-8601 timestamp", () => {
    const r = parseAt("2026-07-05T09:00:00Z", NOW);
    expect(r).toEqual({ ok: true, ms: Date.parse("2026-07-05T09:00:00Z") });
  });

  it("parses a timestamp with timezone offset", () => {
    const r = parseAt("2026-07-05T09:00:00-05:00", NOW);
    expect(r.ok).toBe(true);
  });

  it("rejects a past timestamp with reason 'past'", () => {
    const r = parseAt("2000-01-01T00:00:00Z", NOW);
    expect(r).toEqual({ ok: false, reason: "past" });
  });

  it("rejects exactly 'now' as past (<=)", () => {
    const r = parseAt("2026-07-04T12:00:00Z", NOW);
    expect(r).toEqual({ ok: false, reason: "past" });
  });

  it("rejects a non-timestamp string with reason 'invalid'", () => {
    expect(parseAt("not-a-timestamp", NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a date-only ISO string (no T separator)", () => {
    expect(parseAt("2026-07-05", NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects malformed input", () => {
    expect(parseAt("2026-13-99T99:99:99Z", NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("parseIn", () => {
  it("returns now + duration for a valid duration", () => {
    const r = parseIn("30m", NOW);
    expect(r).toEqual({ ok: true, ms: NOW + 30 * MS_PER_MINUTE });
  });

  it("handles hours and days", () => {
    expect(parseIn("2h", NOW)).toEqual({ ok: true, ms: NOW + 2 * MS_PER_HOUR });
    expect(parseIn("1d", NOW)).toEqual({ ok: true, ms: NOW + MS_PER_DAY });
  });

  it("rejects an invalid duration with reason 'invalid'", () => {
    expect(parseIn("soon", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(parseIn("0m", NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("formatDuration", () => {
  it("formats whole days", () => {
    expect(formatDuration(MS_PER_DAY)).toBe("1d");
    expect(formatDuration(3 * MS_PER_DAY)).toBe("3d");
  });

  it("formats whole hours", () => {
    expect(formatDuration(2 * MS_PER_HOUR)).toBe("2h");
  });

  it("formats whole minutes", () => {
    expect(formatDuration(30 * MS_PER_MINUTE)).toBe("30m");
  });

  it("prefers the largest even unit", () => {
    expect(formatDuration(MS_PER_DAY)).toBe("1d");
    expect(formatDuration(24 * MS_PER_HOUR)).toBe("1d");
  });
});

describe("formatRunTime", () => {
  it("formats epoch ms as ISO-8601", () => {
    expect(formatRunTime(NOW)).toBe("2026-07-04T12:00:00.000Z");
  });
});
