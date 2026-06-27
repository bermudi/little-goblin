import { describe, it, expect } from "bun:test";
import { HELP_REPLY } from "./help.ts";

describe("HELP_REPLY", () => {
  it("lists every command mandated by the spec", () => {
    // Spec scenario: "Help output" — the reply MUST list all available
    // commands: /cancel, /new, /archive, /compact, /debug, /subagents,
    // /cancel_subagent, /revive, /help. Pin the set so a future
    // refactor that drops one fails loudly.
    const required = [
      "/cancel",
      "/new",
      "/archive",
      "/project",
      "/model",
      "/compact",
      "/debug",
      "/think",
      "/name",
      "/resume",
      "/voice",
      "/ping",
      "/start",
      "/subagents",
      "/cancel_subagent",
      "/revive",
      "/help",
    ];
    for (const cmd of required) {
      expect(HELP_REPLY).toContain(cmd);
    }
  });

  it("does not advertise implemented subagent commands as stubs", () => {
    expect(HELP_REPLY).not.toContain("not implemented");
    expect(HELP_REPLY).toContain("/revive <id> <prompt>");
  });

  it("renders as a multi-line string", () => {
    expect(HELP_REPLY.split("\n").length).toBeGreaterThan(5);
  });
});
