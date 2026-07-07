import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { formatSnapshot } from "./snapshot.ts";
import {
  includeAgentsFor,
  personaPolicyForCaller,
  personaSectionFor,
} from "./context.ts";
import type { ActiveScope } from "./scope.ts";

const GENERAL_SCOPE: ActiveScope = {
  chatId: 123,
  topicScope: "general",
  namedAgent: null,
};

describe("memory context — caller-typed policy", () => {
  describe("personaPolicyForCaller", () => {
    it("main → { kind: 'all' } (searches every persona)", () => {
      expect(personaPolicyForCaller({ kind: "main" })).toEqual({ kind: "all" });
    });

    it("named-subagent → { kind: 'own', name } (searches only its persona)", () => {
      expect(personaPolicyForCaller({ kind: "named-subagent", name: "researcher" })).toEqual({
        kind: "own",
        name: "researcher",
      });
    });

    it("anonymous-subagent → { kind: 'none' } (searches no persona)", () => {
      expect(personaPolicyForCaller({ kind: "anonymous-subagent" })).toEqual({ kind: "none" });
    });
  });

  describe("personaSectionFor", () => {
    it("main → undefined (no ## agent persona section)", () => {
      expect(personaSectionFor({ kind: "main" })).toBeUndefined();
    });

    it("named-subagent → { name } (renders ## agent persona)", () => {
      expect(personaSectionFor({ kind: "named-subagent", name: "researcher" })).toEqual({
        name: "researcher",
      });
    });

    it("anonymous-subagent → undefined (no persona section)", () => {
      expect(personaSectionFor({ kind: "anonymous-subagent" })).toBeUndefined();
    });
  });

  describe("includeAgentsFor", () => {
    it("main → true (other scopes lists other agents)", () => {
      expect(includeAgentsFor({ kind: "main" })).toBe(true);
    });

    it("named-subagent → false (subagents do not see other agents)", () => {
      expect(includeAgentsFor({ kind: "named-subagent", name: "researcher" })).toBe(false);
    });

    it("anonymous-subagent → false", () => {
      expect(includeAgentsFor({ kind: "anonymous-subagent" })).toBe(false);
    });
  });

  describe("formatSnapshot visibility per caller kind", () => {
    let tmpDir: string;
    let store: MemoryStore;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "goblin-context-"));
      store = new MemoryStore(tmpDir);
      // Seed a persona scope so we can assert who sees it.
      await store.add({ agent: { name: "researcher" } }, "researcher knows things");
      // Seed general memory so the snapshot is non-empty for main/anonymous.
      await store.add("general", "general memory");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("main sees all personas in ## other scopes", async () => {
      const snap = await formatSnapshot({
        store,
        activeScope: GENERAL_SCOPE,
        caller: { kind: "main" },
      });
      expect(snap).not.toBeNull();
      expect(snap!.content).toContain("agents/researcher");
    });

    it("named-subagent does NOT see other agents in ## other scopes, but sees its own persona", async () => {
      const namedScope: ActiveScope = {
        chatId: 123,
        topicScope: "general",
        namedAgent: { name: "researcher" },
      };
      const snap = await formatSnapshot({
        store,
        activeScope: namedScope,
        caller: { kind: "named-subagent", name: "researcher" },
      });
      expect(snap).not.toBeNull();
      // Its own persona section renders.
      expect(snap!.content).toContain("## agent persona");
      expect(snap!.content).toContain("researcher knows things");
      // Other agents' scopes are NOT listed.
      expect(snap!.content).not.toMatch(/## other scopes[\s\S]*agents\//);
    });

    it("anonymous-subagent sees no persona sections at all", async () => {
      const snap = await formatSnapshot({
        store,
        activeScope: GENERAL_SCOPE,
        caller: { kind: "anonymous-subagent" },
      });
      expect(snap).not.toBeNull();
      expect(snap!.content).not.toContain("## agent persona");
      expect(snap!.content).not.toMatch(/## other scopes[\s\S]*agents\//);
    });
  });
});
