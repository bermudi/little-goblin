/**
 * /think command tests.
 */

import { describe, it, expect } from "bun:test";
import { executeThink, NO_SESSION_REPLY } from "./think.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

function makeDeps(
  overrides: Partial<Parameters<typeof executeThink>[0]> = {},
): Parameters<typeof executeThink>[0] {
  return {
    hasSession: true,
    rawText: "/think",
    currentLevel: "medium",
    setThinkingLevel: () => {},
    ...overrides,
  };
}

describe("executeThink", () => {
  it("returns no-session when there is no session", () => {
    const result = executeThink(makeDeps({ hasSession: false }));
    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_SESSION_REPLY);
  });

  it("lists levels when no argument", () => {
    const result = executeThink(makeDeps({ rawText: "/think", currentLevel: "high" }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("Current: `high`");
    expect(result.reply).toContain("off");
    expect(result.reply).toContain("xhigh");
    expect(result.reply).toContain("high ✅");
  });

  it("lists levels when argument is only whitespace", () => {
    const result = executeThink(makeDeps({ rawText: "/think   ", currentLevel: "low" }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("low ✅");
  });

  it("sets a valid level", () => {
    let setLevel: ThinkingLevel | undefined;
    const result = executeThink(
      makeDeps({
        rawText: "/think high",
        setThinkingLevel: (level) => {
          setLevel = level;
        },
      }),
    );
    expect(result.kind).toBe("set");
    expect(result.reply).toBe("Thinking level set to `high`");
    expect(setLevel).toBe("high");
  });

  it("is case-insensitive", () => {
    let setLevel: ThinkingLevel | undefined;
    const result = executeThink(
      makeDeps({
        rawText: "/think XHIGH",
        setThinkingLevel: (level) => {
          setLevel = level;
        },
      }),
    );
    expect(result.kind).toBe("set");
    expect(setLevel).toBe("xhigh");
  });

  it("rejects an unknown level", () => {
    const result = executeThink(makeDeps({ rawText: "/think turbo" }));
    expect(result.kind).toBe("bad-level");
    expect(result.reply).toContain("Unknown level");
  });

  it("clears override with 'clear'", () => {
    let cleared = false;
    const result = executeThink(
      makeDeps({
        rawText: "/think clear",
        setThinkingLevel: (level) => {
          if (level === undefined) cleared = true;
        },
      }),
    );
    expect(result.kind).toBe("cleared");
    expect(cleared).toBe(true);
  });

  it("clears override with 'none'", () => {
    let cleared = false;
    const result = executeThink(
      makeDeps({
        rawText: "/think none",
        setThinkingLevel: (level) => {
          if (level === undefined) cleared = true;
        },
      }),
    );
    expect(result.kind).toBe("cleared");
    expect(cleared).toBe(true);
  });
});
