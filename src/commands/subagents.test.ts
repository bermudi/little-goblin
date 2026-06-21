import { describe, it, expect } from "bun:test";
import {
  formatSubagentsList,
  NO_SUBAGENTS_REPLY,
  parseReviveSubagentArgs,
  parseSubagentId,
} from "./subagents.ts";
import type { SubagentInfo } from "../subagents/mod.ts";

describe("parseSubagentId", () => {
  it("returns the first argument", () => {
    expect(parseSubagentId("/cancel_subagent abc123")).toBe("abc123");
  });

  it("returns null when no argument is supplied", () => {
    expect(parseSubagentId("/cancel_subagent")).toBe(null);
  });

  it("returns null when only trailing whitespace follows the command", () => {
    expect(parseSubagentId("/revive   ")).toBe(null);
  });

  it("ignores extra arguments past the first", () => {
    expect(parseSubagentId("/revive abc123 ignored garbage")).toBe("abc123");
  });

  it("collapses runs of whitespace", () => {
    expect(parseSubagentId("/revive\t  abc123")).toBe("abc123");
  });
});

describe("parseReviveSubagentArgs", () => {
  it("returns null without an id", () => {
    expect(parseReviveSubagentArgs("/revive")).toBe(null);
  });

  it("returns null when only id is supplied", () => {
    expect(parseReviveSubagentArgs("/revive abc123")).toBe(null);
  });

  it("preserves the follow-up prompt after the id", () => {
    expect(parseReviveSubagentArgs("/revive abc123 inspect the logs again")).toEqual({
      id: "abc123",
      prompt: "inspect the logs again",
    });
  });
});

describe("formatSubagentsList", () => {
  it("reports when no subagents are tracked", () => {
    expect(formatSubagentsList([])).toBe(NO_SUBAGENTS_REPLY);
  });

  it("renders tracked subagents", () => {
    const infos: SubagentInfo[] = [
      {
        id: "abc123",
        name: null,
        role: "generic",
        status: "running",
        spawnedAt: "2026-06-21T00:00:00.000Z",
        spawnedBy: "session-1",
      },
      {
        id: "def456",
        name: "researcher",
        role: "named",
        status: "completed",
        spawnedAt: "2026-06-21T01:00:00.000Z",
        spawnedBy: null,
      },
    ];

    const out = formatSubagentsList(infos);
    expect(out).toContain("Tracked subagents:");
    expect(out).toContain("abc123 — running generic");
    expect(out).toContain("spawned by session-1");
    expect(out).toContain("def456 (researcher) — completed named");
  });
});
