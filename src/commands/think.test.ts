/**
 * /think command tests.
 */

import { describe, it, expect } from "bun:test";
import { executeThink, ALL_LEVELS } from "./think.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** All levels — simulates a model that supports every level (e.g. Claude). */
const FULL_LEVELS = ALL_LEVELS;

/** Off-only — simulates a non-reasoning model. */
const OFF_ONLY: readonly ThinkingLevel[] = ["off"];

/** No xhigh — simulates a reasoning model that doesn't support xhigh. */
const NO_XHIGH: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** High/max only — simulates models like deepseek-v4-flash whose thinkingLevelMap nulls the lower levels. */
const HIGH_MAX_ONLY: readonly ThinkingLevel[] = ["high", "max"];

function makeDeps(
  overrides: Partial<Parameters<typeof executeThink>[0]> = {},
): Parameters<typeof executeThink>[0] {
  return {
    rawText: "/think",
    currentLevel: "medium",
    supportedLevels: FULL_LEVELS,
    ...overrides,
  };
}

describe("executeThink", () => {
  it("lists levels even without an active conversation", () => {
    const result = executeThink(makeDeps({ currentLevel: "high" }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("Current: `high`");
  });

  it("lists levels when no argument", () => {
    const result = executeThink(makeDeps({ rawText: "/think", currentLevel: "high" }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("Current: `high`");
    expect(result.reply).toContain("off");
    expect(result.reply).toContain("xhigh");
    expect(result.reply).toContain("max");
    expect(result.reply).toContain("high ✅");
  });

  it("ALL_LEVELS covers every upstream ThinkingLevel including max", () => {
    expect(ALL_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("shows the clamped current level as the selected entry for a high/max-only model", () => {
    const result = executeThink(makeDeps({ rawText: "/think", currentLevel: "high", supportedLevels: HIGH_MAX_ONLY }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("Current: `high`");
    expect(result.reply).toContain("high ✅");
    expect(result.reply).toContain("max");
    expect(result.reply).not.toContain("medium");
  });

  it("only shows levels supported by the model", () => {
    const result = executeThink(makeDeps({ rawText: "/think", currentLevel: "off", supportedLevels: OFF_ONLY }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("off ✅");
    expect(result.reply).not.toContain("xhigh");
    expect(result.reply).not.toContain("medium");
  });

  it("omits xhigh when model does not support it", () => {
    const result = executeThink(makeDeps({ rawText: "/think", currentLevel: "high", supportedLevels: NO_XHIGH }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("high ✅");
    expect(result.reply).not.toContain("xhigh");
  });

  it("lists levels when argument is only whitespace", () => {
    const result = executeThink(makeDeps({ rawText: "/think   ", currentLevel: "low" }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("low ✅");
  });

  it("sets a valid level", () => {
    const result = executeThink(
      makeDeps({
        rawText: "/think high",
      }),
    );
    expect(result.kind).toBe("set");
    expect(result.reply).toBe("Thinking level set to `high`");
    if (result.kind === "set") {
      expect(result.level).toBe("high");
    }
  });

  it("is case-insensitive", () => {
    const result = executeThink(
      makeDeps({
        rawText: "/think XHIGH",
      }),
    );
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.level).toBe("xhigh");
    }
  });

  it("rejects an unknown level", () => {
    const result = executeThink(makeDeps({ rawText: "/think turbo" }));
    expect(result.kind).toBe("bad-level");
    expect(result.reply).toContain("Unknown level");
  });

  it("rejects a level not supported by the model", () => {
    const result = executeThink(makeDeps({ rawText: "/think xhigh", supportedLevels: NO_XHIGH }));
    expect(result.kind).toBe("bad-level");
    expect(result.reply).toContain("Unknown level");
    expect(result.reply).toContain("Valid for this model");
    // The valid levels listed should not include xhigh
    expect(result.reply).toContain("high");
  });

  it("clears override with 'clear'", () => {
    const result = executeThink(
      makeDeps({
        rawText: "/think clear",
      }),
    );
    expect(result.kind).toBe("cleared");
  });

  it("clears override with 'none'", () => {
    const result = executeThink(
      makeDeps({
        rawText: "/think none",
      }),
    );
    expect(result.kind).toBe("cleared");
  });
});
