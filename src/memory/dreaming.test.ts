import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCandidateExtractor, DreamingPipeline, type TranscriptLine } from "./dreaming.ts";
import { MemoryStore } from "./store.ts";
import { sessionDir, transcriptPath } from "../sessions/paths.ts";
import type { ActiveScope } from "./scope.ts";

// Keep the global budget high so overflow/compaction behaviour does not
// interfere with the deterministic assertions in this file.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "1000000";

function line(index: number, role: TranscriptLine["role"], text: string): TranscriptLine {
  return { index, role, text, ts: new Date().toISOString() };
}

describe("defaultCandidateExtractor", () => {
  it("extracts preferences from I prefer X", () => {
    const entries = [line(0, "user", "I prefer TypeScript")];
    const got = defaultCandidateExtractor(entries, { sessionId: "s1" });

    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({
      target: "user",
      category: "preference",
      confidence: 0.8,
      summary: "I prefer TypeScript",
      source: { sessionId: "s1", lineRange: [0, 0], sourceRole: "user" },
    });
  });

  it("extracts conventions from by convention", () => {
    const entries = [line(1, "assistant", "By convention, we write tests first.")];
    const got = defaultCandidateExtractor(entries, { sessionId: "s1" });

    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({
      target: "memory",
      category: "convention",
      confidence: 0.75,
      summary: "By convention, we write tests first.",
      source: { sessionId: "s1", lineRange: [1, 1], sourceRole: "assistant" },
    });
  });

  it("extracts decisions from we decided phrases", () => {
    const entries = [line(2, "user", "we decided that we should use SQLite")];
    const got = defaultCandidateExtractor(entries, { sessionId: "s1" });

    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({
      target: "memory",
      category: "decision",
      confidence: 0.85,
      summary: "we decided that we should use SQLite",
      source: { sessionId: "s1", lineRange: [2, 2], sourceRole: "user" },
    });
  });

  it("skips procedural noise like ok and thanks", () => {
    const entries = [
      line(0, "user", "ok"),
      line(1, "assistant", "thanks"),
      line(2, "user", "hello"),
    ];
    expect(defaultCandidateExtractor(entries, { sessionId: "s1" })).toEqual([]);
  });

  it("returns empty for unrelated lines", () => {
    const entries = [
      line(0, "user", "The weather is nice today."),
      line(1, "toolResult", "I prefer TypeScript"),
      line(2, "unknown", "by convention"),
    ];
    expect(defaultCandidateExtractor(entries, { sessionId: "s1" })).toEqual([]);
  });
});

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

  it("runDeepSleep promotes short_term entries to fact and compacts", async () => {
    const id1 = await store.addEntry({
      scope: "general",
      entryKind: "memory",
      text: "short term fact one",
      category: "short_term",
      origin: "dreaming",
      sourceSession: "abcdef1234",
    });
    const id2 = await store.addEntry({
      scope: "user",
      entryKind: "user",
      text: "short term user note",
      category: "short_term",
      origin: "dreaming",
      sourceSession: "abcdef1234",
    });
    const id3 = await store.addEntry({
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
        { id: string; category: string | null; entry_kind: string; promoted_at: number | null },
        Record<string, never>
      >("SELECT id, category, entry_kind, promoted_at FROM memory_entries WHERE entry_kind IN ('memory', 'user')")
      .all({});
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(id1)?.category).toBe("fact");
    expect(byId.get(id1)?.promoted_at).not.toBeNull();
    expect(byId.get(id2)?.category).toBe("fact");
    expect(byId.get(id2)?.promoted_at).not.toBeNull();
    expect(byId.get(id3)?.category).toBe("fact");
    expect(rows.filter((r) => r.category === "short_term")).toHaveLength(0);
  });

  it("runRemSleep promotes recurring tags to theme entries", async () => {
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
        { text: string; category: string | null; source_session: string | null },
        Record<string, never>
      >("SELECT text, category, source_session FROM memory_entries WHERE entry_kind = 'memory' AND scope = 'general'")
      .all({});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("theme");
    expect(rows[0]?.text).toContain("backup");
    expect(rows[0]?.text).toContain("3 sessions");
  });

  it("runLightSleep extracts and persists durable candidates", async () => {
    const sessionId = "abcdef1234";
    const entry = {
      ts: new Date().toISOString(),
      role: "user",
      content: [{ type: "text" as const, text: "I prefer dark mode" }],
    };
    mkdirSync(sessionDir(tmp, sessionId), { recursive: true });
    writeFileSync(transcriptPath(tmp, sessionId), JSON.stringify(entry) + "\n", "utf-8");

    store.db.setMeta(
      `dreaming_cursor:${sessionId}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    const activeScope: ActiveScope = { chatId: 0, topicScope: "general", namedAgent: null };
    await pipeline.runLightSleep(sessionId, activeScope);

    expect(store.readBody("user")).toBe("I prefer dark mode");
  });
});
