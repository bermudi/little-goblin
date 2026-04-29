import { describe, it, expect } from "bun:test";
import { parseSubagentId, SUBAGENT_STUB_REPLY } from "./subagents.ts";

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

describe("SUBAGENT_STUB_REPLY", () => {
  it("is the canonical stub string mandated by the spec", () => {
    // Spec: scenarios for /subagents, /cancel_subagent, /revive all
    // require the literal reply "Not implemented" until subagent-runtime
    // ships. Pin it so refactors do not silently change wire output.
    expect(SUBAGENT_STUB_REPLY).toBe("Not implemented");
  });
});
