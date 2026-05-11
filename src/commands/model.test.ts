/**
 * Tests for /model command logic.
 */

import { describe, it, expect, mock } from "bun:test";
import { executeModel, NO_SESSION_REPLY, NO_FAVORITES_REPLY } from "./model.ts";
import type { Config } from "../config.ts";

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
    favorites,
  };
}

describe("executeModel", () => {
  it("returns no-session when there is no session", () => {
    const result = executeModel({
      hasSession: false,
      rawText: "/model 1",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      setModelName: mock(),
    });
    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_SESSION_REPLY);
  });

  it("returns no-favorites when list is empty", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model",
      favorites: [],
      cfg: makeConfig([]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      setModelName: mock(),
    });
    expect(result.kind).toBe("no-favorites");
    expect(result.reply).toBe(NO_FAVORITES_REPLY);
  });

  it("lists favorites when no argument", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model",
      favorites: ["poe/A", "poe/B"],
      cfg: makeConfig(["poe/A", "poe/B"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("Current: `poe/A`");
    expect(result.reply).toContain("1. poe/A ✅");
    expect(result.reply).toContain("2. poe/B");
  });

  it("switches to a valid model by index", () => {
    const setModelName = mock();
    const result = executeModel({
      hasSession: true,
      rawText: "/model 1",
      favorites: ["poe/Claude-Sonnet-4.6"],
      cfg: makeConfig(["poe/Claude-Sonnet-4.6"]),
      currentModelName: "poe/Claude-Sonnet-4.6",
      setModelName,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.modelName).toBe("poe/Claude-Sonnet-4.6");
    }
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });

  it("rejects out-of-range index", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model 5",
      favorites: ["poe/A", "poe/B"],
      cfg: makeConfig(["poe/A", "poe/B"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("bad-index");
    expect(result.reply).toContain("Invalid index");
  });

  it("rejects zero index", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model 0",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("bad-index");
  });

  it("rejects negative index", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model -1",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("bad-index");
  });

  it("rejects non-numeric argument for unknown model", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model foo",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("bad-model");
    expect(result.reply).toContain("Unknown MODEL_NAME");
  });

  it("switches to a valid model by direct id", () => {
    const setModelName = mock();
    const result = executeModel({
      hasSession: true,
      rawText: "/model poe/Claude-Sonnet-4.6",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.modelName).toBe("poe/Claude-Sonnet-4.6");
    }
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });

  it("rejects model without required API key", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model 1",
      favorites: ["anthropic/claude-sonnet-4.6"],
      cfg: makeConfig(["anthropic/claude-sonnet-4.6"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("bad-model");
    expect(result.reply).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects unknown model", () => {
    const result = executeModel({
      hasSession: true,
      rawText: "/model 1",
      favorites: ["unknown/model"],
      cfg: makeConfig(["unknown/model"]),
      currentModelName: "poe/A",
      setModelName: mock(),
    });
    expect(result.kind).toBe("bad-model");
    expect(result.reply).toContain("Unknown MODEL_NAME");
  });

  it("clears override with 'none'", () => {
    const setModelName = mock();
    const result = executeModel({
      hasSession: true,
      rawText: "/model none",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName,
    });
    expect(result.kind).toBe("cleared");
    expect(setModelName).toHaveBeenCalledWith(undefined);
  });

  it("clears override with 'clear'", () => {
    const setModelName = mock();
    const result = executeModel({
      hasSession: true,
      rawText: "/model clear",
      favorites: ["poe/A"],
      cfg: makeConfig(["poe/A"]),
      currentModelName: "poe/A",
      setModelName,
    });
    expect(result.kind).toBe("cleared");
    expect(setModelName).toHaveBeenCalledWith(undefined);
  });

  it("switches to a valid model by direct id even when favorites is empty", () => {
    const setModelName = mock();
    const result = executeModel({
      hasSession: true,
      rawText: "/model poe/Claude-Sonnet-4.6",
      favorites: [],
      cfg: makeConfig([]),
      currentModelName: "poe/A",
      setModelName,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.modelName).toBe("poe/Claude-Sonnet-4.6");
    }
    expect(setModelName).toHaveBeenCalledWith("poe/Claude-Sonnet-4.6");
  });
});
