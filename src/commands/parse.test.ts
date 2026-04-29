import { describe, it, expect } from "bun:test";
import { parseCommand } from "./parse.ts";

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
