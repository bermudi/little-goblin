import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamingPipeline, type CandidateExtractor } from "./dreaming.ts";
import { MemoryStore } from "./store.ts";
import { MemoryBudget } from "./budget.ts";
import { MetricsStore } from "../metrics/store.ts";
import { sessionDir, transcriptPath, metricsPath } from "../sessions/paths.ts";
import { surfaceId, topicSurface } from "../surface.ts";
import { quarantinePath, dreamDiaryPath } from "./paths.ts";

// Keep the global budget high so overflow/compaction behaviour does not
// interfere with the deterministic assertions in this file.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "1000000";

function writeTranscriptLine(
  home: string,
  sessionId: string,
  line: { text: string; sourceSurfaceId?: string; role?: "user" | "assistant"; ts?: string },
): void {
  const entry: Record<string, unknown> = {
    ts: line.ts ?? new Date().toISOString(),
    role: line.role ?? "user",
    content: [{ type: "text", text: line.text }],
  };
  if (line.sourceSurfaceId !== undefined) {
    entry.sourceSurfaceId = line.sourceSurfaceId;
  }
  mkdirSync(sessionDir(home, sessionId), { recursive: true });
  writeFileSync(transcriptPath(home, sessionId), JSON.stringify(entry) + "\n", { flag: "a", encoding: "utf-8" });
}

describe("DreamingPipeline", () => {
  let tmp: string;
  let store: MemoryStore;
  let pipeline: DreamingPipeline;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-dreaming-"));
    store = new MemoryStore(tmp);
    const extractor: CandidateExtractor = (lines) =>
      lines.map((line) => ({
        target: "user" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId: "abcdef1234",
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: line.role === "user" ? "user" : line.role === "assistant" ? "assistant" : line.role === "toolResult" ? "tool" : "system",
        },
      }));
    pipeline = new DreamingPipeline({ goblinHome: tmp, store, extractor });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("constructs with a MemoryStore", () => {
    expect(pipeline).toBeInstanceOf(DreamingPipeline);
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

  it("runLightSleep extracts and persists durable candidates", async () => {
    const sessionId = "abcdef1234";
    writeTranscriptLine(tmp, sessionId, { text: "I prefer dark mode" });

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    await pipeline.runLightSleep(sessionId);

    expect(store.readBody("user")).toBe("I prefer dark mode");
  });

  it("runLightSleep promotes moved history to the source topic scope", async () => {
    const sessionId = "abcdef1234";
    const topicA = surfaceId(topicSurface("private", 12345, 1));
    const topicB = surfaceId(topicSurface("private", 12345, 2));
    writeTranscriptLine(tmp, sessionId, { text: "plan A from topic one", sourceSurfaceId: topicA });
    writeTranscriptLine(tmp, sessionId, { text: "plan B from topic two", sourceSurfaceId: topicB });

    pipeline.setExtractor((lines) =>
      lines.map((line) => ({
        target: "memory" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: line.role === "user" ? "user" : "assistant",
        },
      })),
    );

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    await pipeline.runLightSleep(sessionId);

    const rows = store.db.database
      .query<
        { text: string; scope: string },
        Record<string, never>
      >("SELECT text, scope FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});

    expect(rows).toHaveLength(2);
    const byText = new Map(rows.map((r) => [r.text, r.scope]));
    expect(byText.get("plan A from topic one")).toBe("topics/12345/1");
    expect(byText.get("plan B from topic two")).toBe("topics/12345/2");
  });

  it("runLightSleep quarantines candidates spanning conflicting proven scopes", async () => {
    const sessionId = "abcdef1234";
    const topicA = surfaceId(topicSurface("private", 12345, 1));
    const topicB = surfaceId(topicSurface("private", 12345, 2));
    writeTranscriptLine(tmp, sessionId, { text: "first", sourceSurfaceId: topicA });
    writeTranscriptLine(tmp, sessionId, { text: "second", sourceSurfaceId: topicB });

    pipeline.setExtractor((lines) => [
      {
        target: "memory" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: "cross topic idea",
        source: {
          sessionId,
          lineRange: [lines[0]!.index, lines[lines.length - 1]!.index] as [number, number],
          sourceRole: "user",
        },
      },
    ]);

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    await pipeline.runLightSleep(sessionId);

    const memoryRows = store.db.database
      .query<{ count: number }, Record<string, never>>("SELECT COUNT(*) AS count FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});
    expect(memoryRows[0]?.count).toBe(0);
  });

  it("runLightSleep falls back to general for legacy unprovenanced candidates", async () => {
    const sessionId = "abcdef1234";
    writeTranscriptLine(tmp, sessionId, { text: "legacy note without provenance" });

    pipeline.setExtractor((lines) =>
      lines.map((line) => ({
        target: "memory" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: "user",
        },
      })),
    );

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    await pipeline.runLightSleep(sessionId);

    const rows = store.db.database
      .query<
        { text: string; scope: string },
        Record<string, never>
      >("SELECT text, scope FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("legacy note without provenance");
    expect(rows[0]?.scope).toBe("general");
  });

  it("runLightSleep rejects agent targets from the extractor", async () => {
    const sessionId = "abcdef1234";
    writeTranscriptLine(tmp, sessionId, { text: "I want a researcher persona" });

    pipeline.setExtractor((lines) =>
      lines.map((line) => ({
        target: "agent" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: "user",
        },
      })),
    );

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    await pipeline.runLightSleep(sessionId);

    const memoryRows = store.db.database
      .query<{ count: number }, Record<string, never>>("SELECT COUNT(*) AS count FROM memory_entries WHERE entry_kind = 'memory'")
      .all({});
    expect(memoryRows[0]?.count).toBe(0);
  });

  it("drains eligible transcript backlog in bounded batches", async () => {
    const sessionId = "batch-drain";
    for (let i = 0; i < 5; i++) {
      writeTranscriptLine(tmp, sessionId, { text: `fact ${i}` });
    }

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    const extractor: CandidateExtractor = (lines) =>
      lines.map((line) => ({
        target: "user" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: "user" as const,
        },
      }));

    const drainPipeline = new DreamingPipeline({
      goblinHome: tmp,
      store,
      extractor,
      maxModelLines: 2,
    });
    await drainPipeline.runLightSleep(sessionId);

    const user = store.read("user").body;
    const entries = user.length === 0 ? [] : user.split("\n§\n");
    expect(entries).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(user).toContain(`fact ${i}`);
    }
  });

  it("leaves transcript lines appended during extraction for the next invocation", async () => {
    const sessionId = "finite-snapshot";
    writeTranscriptLine(tmp, sessionId, { text: "initial one" });
    writeTranscriptLine(tmp, sessionId, { text: "initial two" });
    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    let appended = false;
    const extractor: CandidateExtractor = (lines) => {
      if (!appended) {
        writeTranscriptLine(tmp, sessionId, { text: "appended during extraction" });
        appended = true;
      }
      return lines.map((line) => ({
        target: "user" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: "user" as const,
        },
      }));
    };

    const snapshotPipeline = new DreamingPipeline({
      goblinHome: tmp,
      store,
      extractor,
      maxModelLines: 1,
    });
    await snapshotPipeline.runLightSleep(sessionId);

    expect(store.read("user").body).toContain("initial one");
    expect(store.read("user").body).toContain("initial two");
    expect(store.read("user").body).not.toContain("appended during extraction");

    await snapshotPipeline.runLightSleep(sessionId);
    expect(store.read("user").body).toContain("appended during extraction");
  });

  it("skips expired transcript lines and records a metric", async () => {
    const sessionId = "expired-lines";
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now).toISOString();

    writeTranscriptLine(tmp, sessionId, { text: "old one", ts: twoHoursAgo });
    writeTranscriptLine(tmp, sessionId, { text: "old two", ts: twoHoursAgo });
    writeTranscriptLine(tmp, sessionId, { text: "recent one", ts: recent });

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    const metrics = new MetricsStore(tmp, "expired-session");
    const extractor: CandidateExtractor = (lines) =>
      lines.map((line) => ({
        target: "user" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: "user" as const,
        },
      }));

    const expiredPipeline = new DreamingPipeline({
      goblinHome: tmp,
      store,
      extractor,
      metrics,
      lookbackHours: 1,
      maxModelLines: 10,
    });
    await expiredPipeline.runLightSleep(sessionId);

    expect(store.read("user").body).toBe("recent one");

    const lines = readFileSync(metricsPath(tmp, "expired-session"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; name: string; value: number });
    const counters = lines.filter(
      (event) => event.type === "counter" && event.name === "memory_dreaming_expired_lines_total",
    );
    expect(counters[counters.length - 1]?.value).toBe(2);
  });

  it("audits procedural noise with a quarantine record and dream diary entry", async () => {
    const sessionId = "noise-audit";
    writeTranscriptLine(tmp, sessionId, { text: "add more memory" });

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    const extractor: CandidateExtractor = (lines) =>
      lines.map((line) => ({
        target: "user" as const,
        category: "fact" as const,
        confidence: 0.9,
        text: line.text,
        source: {
          sessionId,
          lineRange: [line.index, line.index] as [number, number],
          sourceRole: "user" as const,
        },
      }));

    const noisePipeline = new DreamingPipeline({
      goblinHome: tmp,
      store,
      extractor,
    });
    await noisePipeline.runLightSleep(sessionId);

    expect(store.read("user").body).toBe("");

    const quarantineLines = readFileSync(quarantinePath(tmp), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const noiseRecord = quarantineLines.find(
      (record: Record<string, unknown>) => record.reason === "procedural_noise",
    );
    expect(noiseRecord).toBeDefined();
    expect(noiseRecord.targetScope).toBe("user");

    const today = new Date().toISOString().slice(0, 10);
    const diary = readFileSync(dreamDiaryPath(tmp, today), "utf-8");
    expect(diary).toContain("procedural_noise");
  });

  it("quarantines dreaming overflow as budget_exhausted", async () => {
    const overflowTmp = mkdtempSync(join(tmpdir(), "goblin-dreaming-overflow-"));
    try {
      const sessionId = "budget-overflow";
      writeTranscriptLine(overflowTmp, sessionId, {
        text: "this is a very long fact that will overflow the memory budget",
      });

      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "10" });
      const overflowStore = new MemoryStore(overflowTmp, undefined, { budget });
      overflowStore.db.setMeta(
        `dreaming_cursor:${sessionId}`,
        JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
      );

      const extractor: CandidateExtractor = (lines) =>
        lines.map((line) => ({
          target: "user" as const,
          category: "fact" as const,
          confidence: 0.9,
          text: line.text,
          source: {
            sessionId,
            lineRange: [line.index, line.index] as [number, number],
            sourceRole: "user" as const,
          },
        }));

      const overflowPipeline = new DreamingPipeline({
        goblinHome: overflowTmp,
        store: overflowStore,
        extractor,
      });
      await overflowPipeline.runLightSleep(sessionId);

      const quarantineLines = readFileSync(quarantinePath(overflowTmp), "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const overflowRecord = quarantineLines.find(
        (record: Record<string, unknown>) => record.reason === "budget_exhausted",
      );
      expect(overflowRecord).toBeDefined();
      expect(overflowRecord.targetScope).toBe("user");

      overflowStore.close();
    } finally {
      rmSync(overflowTmp, { recursive: true, force: true });
    }
  });
});
