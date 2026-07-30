import { describe, expect, it } from "bun:test";
import {
  formatSkillsStatus,
  parseSkillsCommand,
  SkillsCommandSyntaxError,
} from "./skills.ts";
import { DEFAULT_SKILL_POLICY } from "../agent/skills/mod.ts";
import type { SkillPolicyStatus } from "../orchestration/conversation-lifecycle.ts";
import { personalEnvironment } from "../sessions/environment.ts";

function status(): SkillPolicyStatus {
  return {
    environment: personalEnvironment(),
    policy: DEFAULT_SKILL_POLICY,
    resolvedSkills: {
      skills: [
        { source: "goblin", name: "alpha", filePath: "/goblin/.agents/skills/alpha/SKILL.md" },
        { source: "environment", name: "beta", filePath: "/workspace/.agents/skills/beta/SKILL.md" },
      ],
      diagnostics: [],
      fingerprint: "manifest",
    },
  };
}

describe("/skills command", () => {
  it("parses inspection without arguments", () => {
    expect(parseSkillsCommand("/skills")).toEqual({ kind: "inspect" });
  });

  it("parses source mutations and canonicalizes selected names", () => {
    expect(parseSkillsCommand("/skills environment only zeta alpha alpha")).toEqual({
      kind: "set",
      source: "environment",
      selection: { mode: "selected", names: ["alpha", "zeta"] },
    });
    expect(parseSkillsCommand("/skills host none")).toEqual({
      kind: "set",
      source: "host",
      selection: { mode: "none" },
    });
  });

  it("parses reload separately from policy mutation", () => {
    expect(parseSkillsCommand("/skills reload")).toEqual({ kind: "reload" });
  });

  it("rejects unknown sources, modes, and invalid names", () => {
    expect(() => parseSkillsCommand("/skills package all")).toThrow(SkillsCommandSyntaxError);
    expect(() => parseSkillsCommand("/skills host maybe")).toThrow(SkillsCommandSyntaxError);
    expect(() => parseSkillsCommand("/skills host only Not-valid")).toThrow(/Invalid skill name/);
  });

  it("formats source provenance and bounds long status output", () => {
    const formatted = formatSkillsStatus(status());
    expect(formatted).toContain("goblin: all");
    expect(formatted).toContain("[goblin] alpha — /goblin/.agents/skills/alpha/SKILL.md");
    expect(formatted).toContain("[environment] beta — /workspace/.agents/skills/beta/SKILL.md");

    const bounded = formatSkillsStatus(status(), "Status", 80);
    expect(bounded.length).toBeLessThanOrEqual(80);
    expect(bounded).toContain("status truncated");
  });
});
