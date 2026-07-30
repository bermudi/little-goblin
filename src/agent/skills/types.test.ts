import { describe, expect, it } from "bun:test";
import {
  cloneSkillPolicy,
  normalizeSkillPolicy,
  SkillResolutionError,
  skillPolicyFingerprint,
  validateSkillPolicy,
  type SkillPolicy,
} from "./types.ts";

function canonicalPolicy(): SkillPolicy {
  return {
    goblin: { mode: "all" },
    environment: { mode: "none" },
    host: { mode: "selected", names: ["alpha", "zeta"] },
  };
}

describe("SkillPolicy validation", () => {
  it("canonicalizes selected names while preserving source selections", () => {
    const normalized = normalizeSkillPolicy({
      goblin: { mode: "selected", names: ["zeta", "alpha", "alpha"] },
      environment: { mode: "all" },
      host: { mode: "none" },
    });

    expect(normalized).toEqual({
      goblin: { mode: "selected", names: ["alpha", "zeta"] },
      environment: { mode: "all" },
      host: { mode: "none" },
    });
  });

  it("rejects malformed policy and selection shapes", () => {
    const invalidPolicies: unknown[] = [
      null,
      {},
      {
        goblin: { mode: "all" },
        environment: { mode: "none" },
        host: { mode: "none" },
        extra: { mode: "all" },
      },
      {
        goblin: { mode: "all", extra: true },
        environment: { mode: "none" },
        host: { mode: "none" },
      },
      {
        goblin: { mode: "maybe" },
        environment: { mode: "none" },
        host: { mode: "none" },
      },
    ];

    for (const invalid of invalidPolicies) {
      expect(() => normalizeSkillPolicy(invalid)).toThrow(SkillResolutionError);
    }
  });

  it("rejects empty or invalid selected names", () => {
    for (const names of [[], ["Not-valid"], ["valid", 7]]) {
      expect(() => normalizeSkillPolicy({
        goblin: { mode: "selected", names },
        environment: { mode: "none" },
        host: { mode: "none" },
      })).toThrow(SkillResolutionError);
    }
  });

  it("requires persisted selected names to already be sorted and unique", () => {
    expect(() => validateSkillPolicy(canonicalPolicy())).not.toThrow();
    expect(() => validateSkillPolicy({
      ...canonicalPolicy(),
      host: { mode: "selected", names: ["zeta", "alpha"] },
    })).toThrow(/sorted and unique/);
    expect(() => validateSkillPolicy({
      ...canonicalPolicy(),
      host: { mode: "selected", names: ["alpha", "alpha"] },
    })).toThrow(/sorted and unique/);
  });

  it("returns a detached canonical policy", () => {
    const names = ["zeta", "alpha"];
    const input: SkillPolicy = {
      goblin: { mode: "none" },
      environment: { mode: "none" },
      host: { mode: "selected", names },
    };
    const clone = cloneSkillPolicy(input);
    names.push("omega");

    expect(clone).toEqual({
      goblin: { mode: "none" },
      environment: { mode: "none" },
      host: { mode: "selected", names: ["alpha", "zeta"] },
    });
    expect(clone).not.toBe(input);
  });

  it("fingerprints equivalent canonical policies identically", () => {
    const first: SkillPolicy = {
      goblin: { mode: "none" },
      environment: { mode: "selected", names: ["zeta", "alpha"] },
      host: { mode: "none" },
    };
    const second: SkillPolicy = {
      goblin: { mode: "none" },
      environment: { mode: "selected", names: ["alpha", "zeta"] },
      host: { mode: "none" },
    };

    expect(skillPolicyFingerprint(first)).toBe(skillPolicyFingerprint(second));
    expect(skillPolicyFingerprint(first)).not.toBe(skillPolicyFingerprint({
      ...second,
      host: { mode: "all" },
    }));
  });
});
