import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamingPipeline } from "./dreaming.ts";
import { MemoryStore } from "./store.ts";
import { surfaceId, topicSurface } from "../surface.ts";

// Keep the global budget high so overflow/compaction behaviour does not
// interfere with the deterministic assertions in this file.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "1000000";

describe("DreamingPipeline", () => {
  let tmp: string;
  let store: MemoryStore;
  let pipeline: DreamingPipeline;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-dreaming-"));
    store = new MemoryStore(tmp);
    pipeline = new DreamingPipeline({ goblinHome: tmp, store });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("constructs with a MemoryStore", () => {
    expect(pipeline).toBeInstanceOf(DreamingPipeline);
  });

  it("exposes only the REM/deep/phase-queue surface", () => {
    const names = Object.getOwnPropertyNames(DreamingPipeline.prototype).sort();
    expect(names).toEqual([
      "appendDreamDiary",
      "appendDreamDiarySummary",
      "close",
      "constructor",
      "deepSleepInner",
      "findNearDuplicate",
      "persistCandidate",
      "processCandidate",
      "readTranscriptLinesInRange",
      "remSleepInner",
      "resolveCandidateScope",
      "resolveLineRangeScope",
      "runDeepSleep",
      "runExclusivePhase",
      "runGlobalPhase",
      "runRemSleep",
    ]);
  });

  it("runDeepSleep promotes qualified short_term entries and expires unqualified old ones", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const qualified = await store.addEntry({
      scope: "general",
      entryKind: "memory",
      text: "short term fact one",
      category: "short_term",
      confidence: 0.85,
      recallCount: 3,
      origin: "dreaming",
      sourceSession: "abcdef1234",
      createdAt: now - 2 * day,
      updatedAt: now - 2 * day,
    });
    const userQualified = await store.addEntry({
      scope: "user",
      entryKind: "user",
      text: "short term user note",
      category: "short_term",
      confidence: 0.9,
      recallCount: 2,
      origin: "dreaming",
      sourceSession: "abcdef1234",
      createdAt: now - 25 * 60 * 60 * 1000,
      updatedAt: now - 25 * 60 * 60 * 1000,
    });
    const tooYoung = await store.addEntry({
      scope: "general",
      entryKind: "memory",
      text: "young short term",
      category: "short_term",
      confidence: 0.95,
      recallCount: 10,
      origin: "dreaming",
      sourceSession: "abcdef1234",
      createdAt: now - 30 * 60 * 1000,
      updatedAt: now - 30 * 60 * 1000,
    });
    const unqualifiedOld = await store.addEntry({
      scope: "general",
      entryKind: "memory",
      text: "old unqualified",
      category: "short_term",
      confidence: 0.3,
      recallCount: 0,
      origin: "dreaming",
      sourceSession: "abcdef1234",
      createdAt: now - 8 * day,
      updatedAt: now - 8 * day,
    });
    const existingFact = await store.addEntry({
      scope: "general",
      entryKind: "memory",
      text: "existing fact",
      category: "fact",
      origin: "dreaming",
      sourceSession: "abcdef1234",
    });

    await pipeline.runDeepSleep();

    const rows = store.db.database
      .query<
        { id: string; category: string | null; entry_kind: string; promoted_at: number | null; scope: string },
        Record<string, never>
      >("SELECT id, category, entry_kind, promoted_at, scope FROM memory_entries WHERE entry_kind IN ('memory', 'user')")
      .all({});
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(qualified)?.category).toBe("fact");
    expect(byId.get(qualified)?.promoted_at).not.toBeNull();
    expect(byId.get(userQualified)?.category).toBe("fact");
    expect(byId.get(userQualified)?.promoted_at).not.toBeNull();
    expect(byId.get(tooYoung)?.category).toBe("short_term");
    expect(byId.get(unqualifiedOld)).toBeUndefined();
    expect(byId.get(existingFact)?.category).toBe("fact");
  });

  it("runExclusivePhase and REM sleep serialize on the global phase queue", async () => {
    const order: string[] = [];
    let releaseHold!: () => void;
    const holdDone = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const hold = pipeline.runExclusivePhase(async () => {
      order.push("hold-enter");
      await holdDone;
      order.push("hold-exit");
    });
    await Bun.sleep(10);
    expect(order).toEqual(["hold-enter"]);

    const rem = pipeline.runRemSleep().then(() => {
      order.push("rem-done");
    });
    const light = pipeline.runExclusivePhase(async () => {
      order.push("light");
    });
    await Bun.sleep(10);
    // Both REM and the exclusive phase wait behind the in-flight phase.
    expect(order).toEqual(["hold-enter"]);
    releaseHold();
    await Promise.all([hold, rem, light]);
    // Both queued phases ran strictly after the hold released (their relative
    // completion order is a microtask scheduling artifact, not contract).
    expect(order).toHaveLength(4);
    expect(order).toContain("rem-done");
    expect(order).toContain("light");
    expect(order.indexOf("light")).toBeGreaterThan(order.indexOf("hold-exit"));
    expect(order.indexOf("rem-done")).toBeGreaterThan(order.indexOf("hold-exit"));
  });

  it("runRemSleep promotes recurring tags to the proven topic scope", async () => {
    const topicSurfaceId = surfaceId(topicSurface("private", 12345, 7));
    const sessions = ["abcdef1000", "abcdef1001", "abcdef1002"];
    for (const sessionId of sessions) {
      await store.addEntry({
        scope: `transcript/${sessionId}`,
        entryKind: "transcript",
        text: "backup",
        origin: "transcript",
        sourceSession: sessionId,
        sourceSurfaceId: topicSurfaceId,
      });
    }

    await pipeline.runRemSleep();

    const rows = store.db.database
      .query<
        { text: string; category: string | null; source_session: string | null; scope: string },
        Record<string, never>
      >("SELECT text, category, source_session, scope FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("theme");
    expect(rows[0]?.text).toContain("backup");
    expect(rows[0]?.text).toContain("3 sessions");
    expect(rows[0]?.scope).toBe("topics/12345/7");
  });

  it("runRemSleep falls back to general when no provenance exists", async () => {
    const sessions = ["abcdef1000", "abcdef1001", "abcdef1002"];
    for (const sessionId of sessions) {
      await store.addEntry({
        scope: `transcript/${sessionId}`,
        entryKind: "transcript",
        text: "backup",
        origin: "transcript",
        sourceSession: sessionId,
      });
    }

    await pipeline.runRemSleep();

    const rows = store.db.database
      .query<
        { text: string; category: string | null; scope: string },
        Record<string, never>
      >("SELECT text, category, scope FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("theme");
    expect(rows[0]?.scope).toBe("general");
  });

  it("runRemSleep tie-breaks proven scopes deterministically", async () => {
    const surfaceA = surfaceId(topicSurface("private", 100, 1));
    const surfaceB = surfaceId(topicSurface("private", 100, 2));
    const sessions = ["s1", "s2", "s3"];
    // Three sessions, each contributes one chunk to scope A and one to scope B, with identical updates.
    for (const sessionId of sessions) {
      await store.addEntry({
        scope: `transcript/${sessionId}`,
        entryKind: "transcript",
        text: "backup",
        origin: "transcript",
        sourceSession: sessionId,
        sourceSurfaceId: surfaceA,
        updatedAt: 1,
      });
      await store.addEntry({
        scope: `transcript/${sessionId}`,
        entryKind: "transcript",
        text: "backup",
        origin: "transcript",
        sourceSession: sessionId,
        sourceSurfaceId: surfaceB,
        updatedAt: 1,
      });
    }

    await pipeline.runRemSleep();

    const rows = store.db.database
      .query<
        { scope: string; category: string | null },
        Record<string, never>
      >("SELECT scope, category FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("theme");
    // Same count, same update; scope name ascending picks topics/100/1.
    expect(rows[0]?.scope).toBe("topics/100/1");
  });
});
