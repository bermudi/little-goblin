/**
 * Tests for /model command logic.
 */

import { describe, it, expect, mock } from "bun:test";
import { executeModel, NO_SESSION_REPLY, NO_FAVORITES_REPLY } from "./model.ts";
import type { Config } from "../config.ts";
import { resolveModel } from "../agent/models.ts";

function makeConfig(favorites: string[]): Config {
  return {
    botToken: "test",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-poe",
    openrouterApiKey: undefined,
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    goblinHome: "/tmp",
    logLevel: "info",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites,
  };
}

/** Minimal deps with no thinking-level context (no clamping possible). */
function makeDeps(overrides: Partial<Parameters<typeof executeModel>[0]> = {}): Parameters<typeof executeModel>[0] {
  return {
    hasSession: true,
    rawText: "/model",
    favorites: [],
    cfg: makeConfig([]),
    currentModelName: "poe/Claude-Sonnet-4.6",
    currentThinkingLevel: undefined,
    currentResolvedModel: undefined,
    setModelName: mock(),
    ...overrides,
  };
}

describe("executeModel", () => {
  it("returns no-session when there is no session", () => {
    const result = executeModel(makeDeps({
      hasSession: false,
      rawText: "/model 1",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
    }));
    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_SESSION_REPLY);
  });

  it("returns no-favorites when list is empty", () => {
    const result = executeModel(makeDeps({
      rawText: "/model",
      favorites: [],
      cfg: makeConfig([]),
      currentModelName: "poe/Claude-Sonnet-4.6",
    }));
    expect(result.kind).toBe("no-favorites");
    expect(result.reply).toBe(NO_FAVORITES_REPLY);
  });

  it("lists favorites when no argument", () => {
    const result = executeModel(makeDeps({
      rawText: "/model",
      favorites: ["poe/A", "poe/B"],
      cfg: makeConfig(["poe/A", "poe/B"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("Current: `poe/A`");
    expect(result.reply).toContain("1. poe/A ✅");
    expect(result.reply).toContain("2. poe/B");
  });

  it("lists favorites when @bot suffix is present with no argument", () => {
    // Regression: Telegram clients in groups/topics append @bot to commands.
    // /model@bot with no arg must list, not error with "Unknown MODEL_NAME".
    const result = executeModel(makeDeps({
      rawText: "/model@bermudi_little_goblin_bot",
      favorites: ["poe/A", "poe/B"],
      cfg: makeConfig(["poe/A", "poe/B"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("list");
  });

  it("switches by index when @bot suffix is present", () => {
    const setModelName = mock();
    const result = executeModel(makeDeps({
      rawText: "/model@bermudi_little_goblin_bot 1",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      setModelName,
    }));
    expect(result.kind).toBe("set");
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });

  it("switches to a valid model by index", () => {
    const setModelName = mock();
    const result = executeModel(makeDeps({
      rawText: "/model 1",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      setModelName,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.modelName).toBe("poe/Claude-Sonnet-4.6");
    }
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });

  it("rejects out-of-range index", () => {
    const result = executeModel(makeDeps({
      rawText: "/model 5",
      favorites: ["poe/A", "poe/B"],
      cfg: makeConfig(["poe/A", "poe/B"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("bad-index");
    expect(result.reply).toContain("Invalid index");
  });

  it("rejects zero index", () => {
    const result = executeModel(makeDeps({
      rawText: "/model 0",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("bad-index");
  });

  it("rejects negative index", () => {
    const result = executeModel(makeDeps({
      rawText: "/model -1",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("bad-index");
  });

  it("rejects non-numeric argument for unknown model", () => {
    const result = executeModel(makeDeps({
      rawText: "/model foo",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("bad-model");
    expect(result.reply).toContain("Unknown MODEL_NAME");
  });

  it("switches to a valid model by direct id", () => {
    const setModelName = mock();
    const result = executeModel(makeDeps({
      rawText: "/model poe/Claude-Sonnet-4.6",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.modelName).toBe("poe/Claude-Sonnet-4.6");
    }
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });

  it("rejects model without required API key", () => {
    const result = executeModel(makeDeps({
      rawText: "/model 1",
      favorites: ["anthropic/claude-sonnet-4.6"],
      cfg: makeConfig(["anthropic/claude-sonnet-4.6"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("bad-model");
    expect(result.reply).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects unknown model", () => {
    const result = executeModel(makeDeps({
      rawText: "/model 1",
      favorites: ["unknown/model"],
      cfg: makeConfig(["unknown/model"]),
      currentModelName: "poe/A",
    }));
    expect(result.kind).toBe("bad-model");
    expect(result.reply).toContain("Unknown MODEL_NAME");
  });

  it("clears override with 'none'", () => {
    const setModelName = mock();
    const result = executeModel(makeDeps({
      rawText: "/model none",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName,
    }));
    expect(result.kind).toBe("cleared");
    expect(setModelName).toHaveBeenCalledWith(undefined);
  });

  it("clears override with 'clear'", () => {
    const setModelName = mock();
    const result = executeModel(makeDeps({
      rawText: "/model clear",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName,
    }));
    expect(result.kind).toBe("cleared");
    expect(setModelName).toHaveBeenCalledWith(undefined);
  });

  it("switches to a valid model by direct id even when favorites is empty", () => {
    const setModelName = mock();
    const result = executeModel(makeDeps({
      rawText: "/model poe/Claude-Sonnet-4.6",
      favorites: [],
      cfg: makeConfig([]),
      currentModelName: "poe/A",
      setModelName,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.modelName).toBe("poe/Claude-Sonnet-4.6");
    }
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });

  it("surfaces thinking level clamping when switching to a weaker model", () => {
    const onThinkingLevelClamped = mock();
    const result = executeModel(makeDeps({
      rawText: "/model poe/gemini-2.5-pro",
      favorites: ["poe/gemini-2.5-pro"],
      cfg: makeConfig(["poe/gemini-2.5-pro"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      // User has an explicit override of xhigh on a Claude model
      currentThinkingLevel: "xhigh",
      currentResolvedModel: undefined,
      onThinkingLevelClamped,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.thinkingClamped).toBeDefined();
      expect(result.reply).toContain("clamped");
    }
    expect(onThinkingLevelClamped).toHaveBeenCalled();
  });

  it("does not surface clamping when levels are compatible", () => {
    const onThinkingLevelClamped = mock();
    const result = executeModel(makeDeps({
      rawText: "/model poe/Claude-Sonnet-4.6",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      currentThinkingLevel: "high",
      currentResolvedModel: undefined,
      onThinkingLevelClamped,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.thinkingClamped).toBeUndefined();
      expect(result.reply).not.toContain("clamped");
    }
    expect(onThinkingLevelClamped).not.toHaveBeenCalled();
  });

  it("clamps when switching from a resolved model with a higher default (no user override)", () => {
    const onThinkingLevelClamped = mock();
    const currentResolved = resolveModel({ ...makeConfig([]), modelName: "poe/Claude-Sonnet-4.6" });
    const result = executeModel(makeDeps({
      rawText: "/model poe/gemini-2.5-pro",
      favorites: ["poe/gemini-2.5-pro"],
      cfg: makeConfig(["poe/gemini-2.5-pro"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      currentThinkingLevel: undefined, // no user override — uses model default
      currentResolvedModel: currentResolved, // default is "high"
      onThinkingLevelClamped,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      // Gemini is non-reasoning, so "high" clamps to "off"
      expect(result.thinkingClamped).toBe("off");
      expect(result.reply).toContain("clamped to `off`");
    }
    expect(onThinkingLevelClamped).toHaveBeenCalledWith("off");
  });

  it("does not clamp when both models can't be resolved and there's no override", () => {
    const onThinkingLevelClamped = mock();
    const result = executeModel(makeDeps({
      rawText: "/model poe/Claude-Sonnet-4.6",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      currentThinkingLevel: undefined,
      currentResolvedModel: undefined,
      onThinkingLevelClamped,
    }));
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.thinkingClamped).toBeUndefined();
      expect(result.reply).not.toContain("clamped");
    }
    expect(onThinkingLevelClamped).not.toHaveBeenCalled();
  });

  it("surfaces clamping on /model clear when default model has lower support", () => {
    const onThinkingLevelClamped = mock();
    const result = executeModel(makeDeps({
      rawText: "/model clear",
      // Default model in cfg is poe/Claude-Sonnet-4.6 — supports xhigh
      // so clearing from a model that had xhigh should not clamp
      cfg: makeConfig([]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      currentThinkingLevel: "high",
      currentResolvedModel: undefined,
      onThinkingLevelClamped,
    }));
    expect(result.kind).toBe("cleared");
    if (result.kind === "cleared") {
      expect(result.thinkingClamped).toBeUndefined();
    }
    expect(onThinkingLevelClamped).not.toHaveBeenCalled();
  });
});
