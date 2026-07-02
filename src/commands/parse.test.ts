import { describe, it, expect } from "bun:test";
import { parseCommand, parseCommandArg } from "./parse.ts";

describe("parseCommand", () => {
  it("returns null for empty / undefined / non-command text", () => {
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("not /a /command")).toBeNull();
  });

  it("returns the command token for a bare slash-command", () => {
    expect(parseCommand("/cancel")).toBe("/cancel");
    expect(parseCommand("/new")).toBe("/new");
  });

  it("drops trailing arguments", () => {
    expect(parseCommand("/cancel_subagent abc123")).toBe("/cancel_subagent");
    expect(parseCommand("/revive  abc123")).toBe("/revive");
  });

  it("strips the @botname suffix Telegram appends in groups/topics", () => {
    // This is the bug surfaced in review: `/cancel@goblinbot` would otherwise
    // miss the switch and fall through to agent routing.
    expect(parseCommand("/cancel@goblinbot")).toBe("/cancel");
    expect(parseCommand("/new@goblinbot")).toBe("/new");
    expect(parseCommand("/cancel_subagent@goblinbot abc123")).toBe("/cancel_subagent");
  });
});

describe("parseCommandArg", () => {
  it("returns empty string when there is no argument", () => {
    expect(parseCommandArg("/model")).toBe("");
    expect(parseCommandArg("/cancel")).toBe("");
  });

  it("extracts the argument after the command", () => {
    expect(parseCommandArg("/model 2")).toBe("2");
    expect(parseCommandArg("/think high")).toBe("high");
    expect(parseCommandArg("/project ~/foo")).toBe("~/foo");
  });

  it("strips the @botname suffix Telegram appends in groups/topics", () => {
    // The core regression: `/model@bot` with no arg must not leak the bot
    // name into the argument (which previously caused "Unknown MODEL_NAME").
    expect(parseCommandArg("/model@bermudi_little_goblin_bot")).toBe("");
    expect(parseCommandArg("/model@bermudi_little_goblin_bot 2")).toBe("2");
    expect(parseCommandArg("/think@bot high")).toBe("high");
  });

  it("preserves internal whitespace in arguments (e.g. paths with spaces)", () => {
    expect(parseCommandArg("/project ~/my dir")).toBe("~/my dir");
    expect(parseCommandArg("/queue@bot run the tests")).toBe("run the tests");
  });

  it("collapses multiple spaces between command and argument", () => {
    expect(parseCommandArg("/model    2")).toBe("2");
    expect(parseCommandArg("/think   high")).toBe("high");
  });
});
