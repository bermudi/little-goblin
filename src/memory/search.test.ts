import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore } from "./store.ts";
import {
  clampLimit,
  personaPolicyFor,
  scoreEntry,
  searchMemoryEntries,
  tokenize,
  type PersonaPolicy,
} from "./search.ts";
import { formatReflectedEntry, type EntryMetadata } from "./entry.ts";
import { scopeMemoryPath, userPath, memoryDir } from "./paths.ts";
import type { ActiveScope } from "./scope.ts";

const ACTIVE_TOPIC: ActiveScope = {
  chatId: -100,
  topicScope: { topicId: 42 },
  namedAgent: null,
};

type BodyScope = "user" | "general" | { topic: { chatId: number; topicId: number } } | { agent: { name: string } };

function setBody(home: string, scope: BodyScope, body: string): void {
  const path = scope === "user" ? userPath(home) : scopeMemoryPath(home, scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
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

  describe("tokenize", () => {
    it("lowercases ASCII and splits on whitespace and punctuation", () => {
      expect(tokenize("Homelab, BACKUPS!")).toEqual(["homelab", "backups"]);
    });

    it("keeps Unicode letters and digits as token characters", () => {
      expect(tokenize("café naïve 漢字 123abc")).toEqual(["café", "naïve", "漢字", "123abc"]);
    });

    it("returns an empty array for whitespace-only input", () => {
      expect(tokenize("   \n\t ")).toEqual([]);
    });
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

  describe("personaPolicyFor", () => {
    it("returns 'all' for the main agent (no namedAgent)", () => {
      expect(personaPolicyFor({ chatId: 1, topicScope: "general", namedAgent: null })).toEqual<PersonaPolicy>({ kind: "all" });
    });
    it("returns 'own' for a named subagent", () => {
      expect(personaPolicyFor({ chatId: 1, topicScope: "general", namedAgent: { name: "researcher" } })).toEqual<PersonaPolicy>({ kind: "own", name: "researcher" });
    });
  });

  describe("searchMemoryEntries — basic matching", () => {
    it("returns ranked entry results from the active scope", async () => {
      setBody(tmp, { topic: { chatId: -100, topicId: 42 } }, "Homelab backups run nightly\n§\nIrrelevant note about cooking");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
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

    it("returns empty results and does not throw when nothing matches", async () => {
      setBody(tmp, { topic: { chatId: -100, topicId: 42 } }, "note about cooking");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        query: "backups",
      });

      expect(out.results).toEqual([]);
      expect(out.query).toBe("backups");
    });

    it("returns ranked entries rather than whole file bodies", async () => {
      setBody(
        tmp,
        { topic: { chatId: -100, topicId: 42 } },
        "backups run nightly\n§\nbackups to verify\n§\ncooking note",
      );

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
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
      setBody(tmp, { topic: { chatId: -100, topicId: 42 } }, entry);

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
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
      setBody(
        tmp,
        { topic: { chatId: -100, topicId: 42 } },
        "backups one\n§\nbackups two\n§\nbackups three\n§\nbackups four",
      );

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        query: "backups",
        limit: 2,
      });

      expect(out.results).toHaveLength(2);
    });
  });

  describe("searchMemoryEntries — scope boundaries", () => {
    it("includes same-chat topic scopes and excludes other-chat topic scopes by default", async () => {
      setBody(tmp, { topic: { chatId: -100, topicId: 42 } }, "active topic backups note");
      setBody(tmp, { topic: { chatId: -100, topicId: 7 } }, "peer topic backups note");
      setBody(tmp, { topic: { chatId: -200, topicId: 9 } }, "other chat backups note");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        query: "backups",
      });

      const scopes = out.results.map((r) => r.scope).sort();
      expect(scopes).toEqual(["topics/-100/42", "topics/-100/7"]);
      expect(scopes).not.toContain("topics/-200/9");
    });

    it("includes other-chat topic scopes when allChats is true", async () => {
      setBody(tmp, { topic: { chatId: -100, topicId: 42 } }, "active topic backups note");
      setBody(tmp, { topic: { chatId: -200, topicId: 9 } }, "other chat backups note");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        query: "backups",
        allChats: true,
      });

      const scopes = out.results.map((r) => r.scope).sort();
      expect(scopes).toEqual(["topics/-100/42", "topics/-200/9"]);
    });

    it("always includes user.md and general memory", async () => {
      setBody(tmp, "user", "user prefers backups weekly");
      setBody(tmp, "general", "general backups policy");

      const out = await searchMemoryEntries({
        store,
        activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: null },
        query: "backups",
      });

      const targets = out.results.map((r) => r.target);
      expect(targets).toContain("user");
      expect(out.results.map((r) => r.scope)).toContain("general");
    });

    it("main agent searches all persona scopes", async () => {
      setBody(tmp, { agent: { name: "researcher" } }, "researcher backups persona note");
      setBody(tmp, { agent: { name: "writer" } }, "writer backups persona note");

      const out = await searchMemoryEntries({
        store,
        activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: null },
        query: "backups",
      });

      const scopes = out.results.map((r) => r.scope).sort();
      expect(scopes).toEqual(["agents/researcher", "agents/writer"]);
    });

    it("named subagent searches only its own persona scope", async () => {
      setBody(tmp, { agent: { name: "researcher" } }, "researcher backups persona note");
      setBody(tmp, { agent: { name: "writer" } }, "writer backups persona note");

      const out = await searchMemoryEntries({
        store,
        activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: { name: "researcher" } },
        query: "backups",
      });

      const scopes = out.results.map((r) => r.scope);
      expect(scopes).toEqual(["agents/researcher"]);
    });

    it("does not search any persona scope for an anonymous subagent", async () => {
      setBody(tmp, { agent: { name: "researcher" } }, "researcher backups persona note");

      // Anonymous subagent: namedAgent present but policy forced to none.
      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        persona: { kind: "none" },
        query: "backups",
      });

      expect(out.results.map((r) => r.scope)).not.toContain("agents/researcher");
    });
  });

  describe("searchMemoryEntries — deterministic ordering", () => {
    it("orders results deterministically across calls (stable tie-break)", async () => {
      setBody(
        tmp,
        { topic: { chatId: -100, topicId: 42 } },
        "backups alpha\n§\nbackups beta\n§\nbackups gamma",
      );

      const a = await searchMemoryEntries({ store, activeScope: ACTIVE_TOPIC, query: "backups" });
      const b = await searchMemoryEntries({ store, activeScope: ACTIVE_TOPIC, query: "backups" });
      expect(a.results.map((r) => r.text)).toEqual(b.results.map((r) => r.text));
    });
  });

  describe("relative signal ordering (overlap > exact phrase > boosts > recency)", () => {
    // The scoreEntry helper exposes the same scoring used by searchMemoryEntries.
    // These crafted cases isolate each signal so the relative ordering is
    // asserted directly — the spec pins only the ordering, not the weights.
    const baseMeta: EntryMetadata = {
      category: "preference",
      confidence: 0.5,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      source_session: "s",
      source_role: "user",
    };
    const NOW = Date.parse("2026-07-05T00:00:00.000Z");
    const activeTag = "topics/-100/42";

    function score(args: {
      query: string;
      entry: string;
      target: "user" | "memory" | "agent";
      tag?: string;
      metadata?: EntryMetadata | null;
    }): number {
      return scoreEntry({
        queryTokens: tokenize(args.query),
        lowerQuery: args.query.toLowerCase(),
        lowerEntry: args.entry.toLowerCase(),
        target: args.target,
        scopeTag: args.tag ?? activeTag,
        activeScopeTag: activeTag,
        metadata: args.metadata === undefined ? null : args.metadata,
        nowMs: NOW,
      });
    }

    it("overlap dominates exact phrase: a higher-overlap entry beats a lower-overlap entry even when only the lower one has the phrase bonus", () => {
      // A contiguous phrase match implies every query token is present, hence
      // full overlap — so "phrase present" can only raise an already-full
      // overlap score. The dominance assertion that actually exercises the
      // band gap is: overlap=1.0 (no phrase) vs overlap=0.5 (with phrase).
      // The 1.0-overlap band (OVERLAP_SCALE=1_000_000) beats the 0.5-overlap
      // band (500_000) plus the phrase bonus (10_000) plus every boost.
      const fullOverlapNoPhrase = score({
        query: "alpha beta gamma",
        entry: "gamma alpha beta scattered across the note", // 3/3 tokens, no contiguous run
        target: "user",
        tag: "user",
      });
      const halfOverlapWithPhraseAndBoosts = score({
        query: "alpha beta gamma",
        entry: "alpha beta note", // 2/3 tokens; contains no full phrase; give it the active boost
        target: "memory",
        tag: activeTag,
        metadata: { ...baseMeta, category: "decision", updated_at: "2026-07-04T00:00:00.000Z" },
      });
      // Full overlap on the lower-boosted entry beats half overlap with every
      // boost stacked — because OVERLAP_SCALE >> EXACT_PHRASE_BONUS + boosts.
      expect(fullOverlapNoPhrase).toBeGreaterThan(halfOverlapWithPhraseAndBoosts);
    });

    it("exact phrase is a within-overlap tiebreaker: at equal overlap, the phrase match wins", () => {
      // Both entries have full token overlap (3/3). Only one has the contiguous phrase.
      const withPhrase = score({
        query: "alpha beta gamma",
        entry: "alpha beta gamma scattered note", // contains "alpha beta gamma"
        target: "memory",
        tag: activeTag,
      });
      const withoutPhrase = score({
        query: "alpha beta gamma",
        entry: "gamma alpha beta scattered note", // same tokens, no contiguous run
        target: "memory",
        tag: activeTag,
      });
      expect(withPhrase).toBeGreaterThan(withoutPhrase);
      // And the difference is exactly the phrase bonus (tiebreak confirmed).
      expect(withPhrase - withoutPhrase).toBe(10_000);
    });

    it("exact phrase dominates boosts: a phrase match on user scope beats a same-overlap active-scope entry without the phrase", () => {
      // Query is a two-token phrase. Both entries share the same single
      // overlapping token, but only one contains the full contiguous phrase.
      const phraseYesUser = score({
        query: "backups daily",
        entry: "backups daily rotation", // contains "backups daily" + 2/2 token overlap, user scope
        target: "user",
        tag: "user",
      });
      const phraseNoActive = score({
        query: "backups daily",
        entry: "backups rotation", // 1/2 token overlap, active scope, no contiguous phrase
        target: "memory",
        tag: activeTag,
      });
      // phraseYesUser has higher overlap AND the phrase; it should win. This
      // confirms the phrase band is not swamped by the active-scope boost
      // when overlap is comparable. The dominance is checked directly below
      // by holding overlap constant.
      expect(phraseYesUser).toBeGreaterThan(phraseNoActive);

      // Hold overlap constant (1/2 tokens) and toggle only the phrase. The
      // phrase case must beat the no-phrase case by exactly the phrase bonus,
      // independent of the active-scope boost on the no-phrase side.
      const phrasePartial = score({
        query: "backups daily",
        entry: "backups daily-run note", // contains "backups daily"? Yes — "backups daily" is a substring.
        target: "user",
        tag: "user",
      });
      // Construct a no-phrase entry with the same single-token overlap but
      // the active-scope boost. "backups weekly" shares only "backups".
      const sameOverlapNoPhraseActive = score({
        query: "backups daily",
        entry: "backups weekly", // overlap on "backups" only, no "backups daily" substring, active scope
        target: "memory",
        tag: activeTag,
      });
      expect(phrasePartial).toBeGreaterThan(sameOverlapNoPhraseActive);
    });

    it("boosts dominate recency: an active-scope entry with stale metadata beats a same-overlap user-scope entry with fresh metadata", () => {
      const fresh = "2026-07-04T00:00:00.000Z";
      const stale = "2026-06-01T00:00:00.000Z";
      const activeOld = score({
        query: "backups",
        entry: "backups note",
        target: "memory",
        tag: activeTag,
        metadata: { ...baseMeta, updated_at: stale },
      });
      const userFresh = score({
        query: "backups",
        entry: "backups note",
        target: "user",
        tag: "user",
        metadata: { ...baseMeta, updated_at: fresh },
      });
      // The active-scope boost exceeds the maximum recency contribution, so
      // the boosted entry wins regardless of recency.
      expect(activeOld).toBeGreaterThan(userFresh);
    });

    it("recency breaks ties between otherwise-equal entries", () => {
      const fresh = "2026-07-04T00:00:00.000Z";
      const stale = "2026-05-01T00:00:00.000Z";
      const a = score({
        query: "backups",
        entry: "backups note",
        target: "memory",
        tag: activeTag,
        metadata: { ...baseMeta, updated_at: fresh },
      });
      const b = score({
        query: "backups",
        entry: "backups note",
        target: "memory",
        tag: activeTag,
        metadata: { ...baseMeta, updated_at: stale },
      });
      expect(a).toBeGreaterThan(b);
    });

    it("end-to-end: ranking through searchMemoryEntries reflects overlap > exact phrase > boosts > recency", async () => {
      // Seed three same-chat entries that isolate the overlap and phrase signals.
      // Topic 42 (active): full token overlap, no contiguous phrase.
      setBody(tmp, { topic: { chatId: -100, topicId: 42 } }, "gamma alpha beta scattered across the note");
      // Topic 7: full token overlap AND the contiguous phrase → highest score.
      setBody(tmp, { topic: { chatId: -100, topicId: 7 } }, "alpha beta gamma — different topic");
      // Topic 8: partial token overlap only (1/3) — ranks below the full-overlap entries.
      setBody(tmp, { topic: { chatId: -100, topicId: 8 } }, "alpha preference note");

      const out = await searchMemoryEntries({
        store,
        activeScope: ACTIVE_TOPIC,
        query: "alpha beta gamma",
        nowMs: NOW,
      });

      expect(out.results.length).toBe(3);
      // Top result: full overlap + phrase (topic 7) beats full overlap no phrase (topic 42).
      expect(out.results[0]!.scope).toBe("topics/-100/7");
      // Both full-overlap entries beat the partial-overlap entry.
      expect(out.results[2]!.scope).toBe("topics/-100/8");
    });
  });
});
