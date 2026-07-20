import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { MetricsStore, readMetricsSummary } from "../metrics/mod.ts";
import {
  clampLimit,
  searchMemoryEntries,
  type PersonaPolicy,
} from "./search.ts";
import { formatReflectedEntry, type EntryMetadata } from "./entry.ts";
import { memoryDir } from "./paths.ts";
import type { ActiveScope } from "./scope.ts";

const ACTIVE_TOPIC: ActiveScope = {
  chatId: -100,
  topicScope: { topicId: 42 },
  namedAgent: null,
};

const MAIN_PERSONA: PersonaPolicy = { kind: "all" };
const RESEARCHER_PERSONA: PersonaPolicy = { kind: "own", name: "researcher" };
const NONE_PERSONA: PersonaPolicy = { kind: "none" };

type BodyScope = "user" | "general" | { topic: { chatId: number; topicId: number } } | { agent: { name: string } };

async function setBody(store: MemoryStore, scope: BodyScope, body: string): Promise<void> {
  const r = await store.rewrite(scope, body);
  if (!r.ok) throw new Error(r.error);
}

describe("memory search", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-search-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("clampLimit", () => {
    it("defaults to 10 when undefined", () => {
      expect(clampLimit(undefined)).toBe(10);
    });
    it("treats values <= 0 as the default", () => {
      expect(clampLimit(0)).toBe(10);
      expect(clampLimit(-5)).toBe(10);
    });
    it("clamps values > 50 to 50", () => {
      expect(clampLimit(999)).toBe(50);
    });
    it("passes through values in [1, 50]", () => {
      expect(clampLimit(3)).toBe(3);
      expect(clampLimit(50)).toBe(50);
    });
    it("floors fractional values then re-checks the <= 0 collapse", () => {
      // 0.5 floors to 0, which collapses to the default rather than yielding
      // an empty result slice.
      expect(clampLimit(0.5)).toBe(10);
      // Fractional values in (0, 1) all collapse to the default.
      expect(clampLimit(0.99)).toBe(10);
      // Fractional values >= 1 floor to the integer part.
      expect(clampLimit(3.7)).toBe(3);
    });
  });

  describe("searchMemoryEntries — basic matching", () => {
    it("returns ranked entry results from the active scope", async () => {
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "Homelab backups run nightly\n§\nIrrelevant note about cooking");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "homelab backups",
      });

      expect(out.results).toHaveLength(1);
      const r = out.results[0]!;
      expect(r.scope).toBe("topics/-100/42");
      expect(r.target).toBe("memory");
      expect(r.text).toBe("Homelab backups run nightly");
      expect(r.score).toBeGreaterThan(0);
      expect(r.metadata).toBeNull();
    });

    it("records a memory_search metric event when metrics is provided", async () => {
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "Homelab backups run nightly");
      const metrics = new MetricsStore(tmp, "abcdef1234");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "homelab backups",
        metrics,
      });

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.searchCount).toBe(1);
      expect(summary.lastSearchResultCount).toBe(out.results.length);
    });

    it("returns empty results and records a memory_search event with resultCount 0", async () => {
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "note about cooking");
      const metrics = new MetricsStore(tmp, "abcdef1234");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
        metrics,
      });

      expect(out.results).toEqual([]);
      expect(out.query).toBe("backups");

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.searchCount).toBe(1);
      expect(summary.lastSearchResultCount).toBe(0);
    });

    it("returns ranked entries rather than whole file bodies", async () => {
      await setBody(
        store,
        { topic: { chatId: -100, topicId: 42 } },
        "backups run nightly\n§\nbackups to verify\n§\ncooking note",
      );

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
      });

      // Two matching entries, the unmatched one is excluded.
      expect(out.results).toHaveLength(2);
      expect(out.results.map((r) => r.text)).not.toContain("cooking note");
    });

    it("parses reflected metadata and strips it from the result text", async () => {
      const meta: EntryMetadata = {
        category: "decision",
        confidence: 0.86,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        source_session: "s_1",
        source_role: "user",
      };
      const entry = formatReflectedEntry(meta, "Decided: nightly homelab backups.");
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, entry);

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "homelab backups",
      });

      expect(out.results).toHaveLength(1);
      const r = out.results[0]!;
      expect(r.text).toBe("Decided: nightly homelab backups.");
      expect(r.metadata).not.toBeNull();
      expect(r.metadata!.category).toBe("decision");
      expect(r.metadata!.confidence).toBeCloseTo(0.86);
      expect(r.metadata!.source_session).toBe("s_1");
    });

    it("applies the result limit after ranking", async () => {
      await setBody(
        store,
        { topic: { chatId: -100, topicId: 42 } },
        "backups one\n§\nbackups two\n§\nbackups three\n§\nbackups four",
      );

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
        limit: 2,
      });

      expect(out.results).toHaveLength(2);
    });
  });

  describe("searchMemoryEntries — scope boundaries", () => {
    it("includes same-chat topic scopes and excludes other-chat topic scopes by default", async () => {
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "active topic backups note");
      await setBody(store, { topic: { chatId: -100, topicId: 7 } }, "peer topic backups note");
      await setBody(store, { topic: { chatId: -200, topicId: 9 } }, "other chat backups note");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
      });

      const scopes = out.results.map((r) => r.scope).sort();
      expect(scopes).toEqual(["topics/-100/42", "topics/-100/7"]);
      expect(scopes).not.toContain("topics/-200/9");
    });

    it("includes other-chat topic scopes when allChats is true", async () => {
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "active topic backups note");
      await setBody(store, { topic: { chatId: -200, topicId: 9 } }, "other chat backups note");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
        allChats: true,
      });

      const scopes = out.results.map((r) => r.scope).sort();
      expect(scopes).toEqual(["topics/-100/42", "topics/-200/9"]);
    });

    it("always includes user.md and general memory", async () => {
      await setBody(store, "user", "user prefers backups weekly");
      await setBody(store, "general", "general backups policy");

      const out = await searchMemoryEntries({
        store,
        activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: null },
        persona: MAIN_PERSONA,
        query: "backups",
      });

      const targets = out.results.map((r) => r.target);
      expect(targets).toContain("user");
      expect(out.results.map((r) => r.scope)).toContain("general");
    });

    it("main agent searches all persona scopes", async () => {
      await setBody(store, { agent: { name: "researcher" } }, "researcher backups persona note");
      await setBody(store, { agent: { name: "writer" } }, "writer backups persona note");

      const out = await searchMemoryEntries({
        store,
        activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: null },
        persona: MAIN_PERSONA,
        query: "backups",
      });

      const scopes = out.results.map((r) => r.scope).sort();
      expect(scopes).toEqual(["agents/researcher", "agents/writer"]);
    });

    it("named subagent searches only its own persona scope", async () => {
      await setBody(store, { agent: { name: "researcher" } }, "researcher backups persona note");
      await setBody(store, { agent: { name: "writer" } }, "writer backups persona note");

      const out = await searchMemoryEntries({
        store,
        activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: { name: "researcher" } },
        persona: RESEARCHER_PERSONA,
        query: "backups",
      });

      const scopes = out.results.map((r) => r.scope);
      expect(scopes).toEqual(["agents/researcher"]);
    });

    it("does not search any persona scope for an anonymous subagent", async () => {
      await setBody(store, { agent: { name: "researcher" } }, "researcher backups persona note");

      // Anonymous subagent: namedAgent present but policy forced to none.
      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: NONE_PERSONA,
        query: "backups",
      });

      expect(out.results.map((r) => r.scope)).not.toContain("agents/researcher");
    });
  });

  describe("searchMemoryEntries — deterministic ordering", () => {
    it("orders results deterministically across calls (stable tie-break)", async () => {
      await setBody(
        store,
        { topic: { chatId: -100, topicId: 42 } },
        "backups alpha\n§\nbackups beta\n§\nbackups gamma",
      );

      const a = await searchMemoryEntries({ store, activeScope: ACTIVE_TOPIC, persona: MAIN_PERSONA, query: "backups" });
      const b = await searchMemoryEntries({ store, activeScope: ACTIVE_TOPIC, persona: MAIN_PERSONA, query: "backups" });
      expect(a.results.map((r) => r.text)).toEqual(b.results.map((r) => r.text));
    });
  });

  describe("searchMemoryEntries — result shape", () => {
    it("includes entry_id, entry_kind, source, and tags on every result", async () => {
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "Homelab backups run nightly");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
      });

      expect(out.results.length).toBeGreaterThan(0);
      const r = out.results[0]!;
      expect(typeof r.entryId).toBe("string");
      expect(r.entryKind).toBe("memory");
      expect(r.source).toBe("memory");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(out.degraded).toBe(false);
    });

    it("truncates long entry text to 500 chars with an ellipsis", async () => {
      const long = "backups ".repeat(200);
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, long);

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backups",
      });

      expect(out.results[0]!.text).toMatch(/\.\.\.$/);
      expect(out.results[0]!.text.length).toBeLessThanOrEqual(503);
    });
  });

  describe("searchMemoryEntries — corpus default", () => {
    it("defaults corpus to all so transcript rows are eligible", async () => {
      const sessionId = "transcript-session";
      await store.addEntries([
        {
          scope: `transcript/${sessionId}`,
          entryKind: "transcript",
          text: "backup verification call",
          origin: "user",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          chatId: String(-100),
        },
      ]);

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "backup",
      });

      const transcriptResult = out.results.find((r) => r.source === "transcript");
      expect(transcriptResult).toBeDefined();
      expect(transcriptResult!.sessionId).toBe(sessionId);
      expect(transcriptResult!.entryKind).toBe("transcript");
    });
  });

  describe("searchMemoryEntries — deterministic ordering", () => {
    it("orders results deterministically across calls (stable tie-break)", async () => {
      await setBody(
        store,
        { topic: { chatId: -100, topicId: 42 } },
        "backups alpha\n§\nbackups beta\n§\nbackups gamma",
      );

      const a = await searchMemoryEntries({ store, activeScope: ACTIVE_TOPIC, persona: MAIN_PERSONA, query: "backups" });
      const b = await searchMemoryEntries({ store, activeScope: ACTIVE_TOPIC, persona: MAIN_PERSONA, query: "backups" });
      expect(a.results.map((r) => r.text)).toEqual(b.results.map((r) => r.text));
    });
  });

  describe("searchMemoryEntries — end-to-end ranking", () => {
    it("ranks full overlap + exact phrase above full overlap without phrase", async () => {
      // Topic 42 (active): full token overlap, no contiguous phrase.
      await setBody(store, { topic: { chatId: -100, topicId: 42 } }, "gamma alpha beta scattered across the note");
      // Topic 7: full token overlap AND the contiguous phrase → highest score.
      await setBody(store, { topic: { chatId: -100, topicId: 7 } }, "alpha beta gamma — different topic");
      // Topic 8: partial token overlap only (1/3) — ranks below the full-overlap entries.
      await setBody(store, { topic: { chatId: -100, topicId: 8 } }, "alpha preference note");

      const NOW = Date.now();
      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: MAIN_PERSONA,
        query: "alpha beta gamma",
        nowMs: NOW,
      });

      expect(out.results.length).toBe(3);
      expect(out.results[0]!.scope).toBe("topics/-100/7");
      expect(out.results[2]!.scope).toBe("topics/-100/8");
    });
  });
});
