import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { MetricsStore, readMetricsSummary } from "../metrics/mod.ts";
import {
  MemoryReflector,
  defaultCandidateExtractor,
  type Candidate,
  type CandidateExtractor,
  type ReflectionCursor,
  type TranscriptLine,
} from "./reflector.ts";
import { quarantinePath } from "./quarantine.ts";
import { memoryDir } from "./paths.ts";
import { sessionDir, transcriptPath } from "../sessions/paths.ts";
import { parseEntryMetadata } from "./entry.ts";
import type { ActiveScope } from "./scope.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GENERAL_SCOPE: ActiveScope = {
  chatId: 123,
  topicScope: "general",
  namedAgent: null,
};

const TOPIC_SCOPE: ActiveScope = {
  chatId: -100,
  topicScope: { topicId: 42 },
  namedAgent: null,
};

function makeTranscriptLine(
  role: TranscriptLine["role"],
  text: string,
  index = 0,
): TranscriptLine {
  return { index, role, text, ts: new Date().toISOString() };
}

function appendTranscript(home: string, sessionId: string, entries: Array<{ role: string; text: string }>): void {
  const dir = sessionDir(home, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = transcriptPath(home, sessionId);
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch { /* ENOENT — start fresh */ }
  for (const entry of entries) {
    content += JSON.stringify({
      ts: new Date().toISOString(),
      role: entry.role,
      content: [{ type: "text", text: entry.text }],
    }) + "\n";
  }
  writeFileSync(path, content, "utf-8");
}

function writeCursor(home: string, sessionId: string, cursor: ReflectionCursor): void {
  const dir = sessionDir(home, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "memory-reflection.json"),
    JSON.stringify(cursor, null, 2) + "\n",
    "utf-8",
  );
}

function readCursor(home: string, sessionId: string): ReflectionCursor | null {
  try {
    const raw = readFileSync(
      join(sessionDir(home, sessionId), "memory-reflection.json"),
      "utf-8",
    );
    return JSON.parse(raw) as ReflectionCursor;
  } catch {
    return null;
  }
}

function readQuarantine(home: string): unknown[] {
  try {
    const raw = readFileSync(quarantinePath(home), "utf-8").trim();
    if (raw.length === 0) return [];
    return raw.split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function makeCandidate(overrides: Partial<Candidate> & { summary: string }): Candidate {
  const { source: sourceOverride, ...rest } = overrides;
  return {
    target: "memory",
    category: "project_fact",
    confidence: 0.8,
    source: {
      sessionId: "abcdef1234",
      lineRange: [0, 0],
      sourceRole: "user",
      ...sourceOverride,
    },
    ...rest,
  };
}

/** Extractor that returns a fixed list of candidates. */
function fixedExtractor(candidates: Candidate[]): CandidateExtractor {
  return () => candidates;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryReflector", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-reflector-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // First-observation cursor seeding
  // -------------------------------------------------------------------------

  describe("first-observation cursor seeding", () => {
    it("seeds cursor to current transcript end and processes nothing", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
        { role: "assistant", text: "Got it." },
        { role: "user", text: "the project uses TypeScript" },
      ]);
      expect(readCursor(tmp, "abcdef1234")).toBeNull();

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([makeCandidate({ summary: "I prefer concise summaries" })]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      // Cursor is seeded to the transcript end (3 lines).
      const cursor = readCursor(tmp, "abcdef1234");
      expect(cursor).not.toBeNull();
      expect(cursor!.processedLines).toBe(3);

      // No memory was written — historical entries are not backfilled.
      expect(store.read("general").body).toBe("");
      expect(readQuarantine(tmp)).toHaveLength(0);
    });

    it("seeds cursor to 0 when transcript is empty", async () => {
      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const cursor = readCursor(tmp, "abcdef1234");
      expect(cursor).not.toBeNull();
      expect(cursor!.processedLines).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cursor skip after restart
  // -------------------------------------------------------------------------

  describe("cursor skip after restart", () => {
    it("processes only entries after the cursor on a subsequent pass", async () => {
      // Pre-seed cursor at line 2 (first 2 lines already reflected).
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
        { role: "assistant", text: "Got it." },
        { role: "user", text: "the project uses TypeScript" },
        { role: "user", text: "we always run bun test" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 2, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([makeCandidate({ summary: "the project uses TypeScript" })]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      // Cursor advanced past all 4 lines.
      const cursor = readCursor(tmp, "abcdef1234");
      expect(cursor!.processedLines).toBe(4);

      // The candidate from line 3 (index 2) was written.
      const body = store.read("general").body;
      expect(body).toContain("the project uses TypeScript");
    });

    it("does nothing when cursor is already at transcript end", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 1, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([makeCandidate({ summary: "should not appear" })]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      expect(store.read("general").body).toBe("");
      // Cursor unchanged (no new lines to process).
      const cursor = readCursor(tmp, "abcdef1234");
      expect(cursor!.processedLines).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Retry when cursor is not advanced
  // -------------------------------------------------------------------------

  describe("retry when cursor is not advanced", () => {
    it("does not advance cursor when the extractor throws", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      let callCount = 0;
      const failingExtractor: CandidateExtractor = () => {
        callCount++;
        throw new Error("extractor blew up");
      };

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: failingExtractor,
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      // Cursor not advanced.
      expect(readCursor(tmp, "abcdef1234")!.processedLines).toBe(0);
      expect(store.read("general").body).toBe("");
      expect(callCount).toBe(1);

      // Retry with a working extractor — same range is reprocessed.
      const goodExtractor = fixedExtractor([makeCandidate({ summary: "I prefer concise summaries" })]);
      const reflector2 = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: goodExtractor,
      });
      await reflector2.reflect("abcdef1234", GENERAL_SCOPE);

      // Cursor advanced and candidate written.
      expect(readCursor(tmp, "abcdef1234")!.processedLines).toBe(1);
      expect(store.read("general").body).toContain("I prefer concise summaries");
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping schedule coalescing
  // -------------------------------------------------------------------------

  describe("overlapping schedule coalescing", () => {
    it("coalesces two rapid schedules into at most two passes (original + one follow-up)", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      let resolveBlocker: () => void = () => {};
      const blocker = new Promise<void>((res) => { resolveBlocker = res; });
      let extractCount = 0;
      const blockingExtractor: CandidateExtractor = async () => {
        extractCount++;
        if (extractCount === 1) {
          await blocker;
        }
        return [];
      };

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: blockingExtractor,
      });

      // Schedule pass 1 — starts and blocks in the extractor.
      reflector.scheduleReflection("abcdef1234", GENERAL_SCOPE);
      // Schedule pass 2 while pass 1 is still running — should coalesce.
      reflector.scheduleReflection("abcdef1234", GENERAL_SCOPE);
      // While pass 1 is blocked, append a new transcript line so the
      // follow-up pass has new work and actually invokes the extractor.
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the project uses TypeScript" },
      ]);

      // Release the first pass.
      resolveBlocker();
      await reflector.awaitSettled("abcdef1234");

      // Exactly 2 passes: the original + one follow-up (not 3+).
      expect(extractCount).toBe(2);
    });

    it("does not schedule a follow-up when no overlap occurs", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      let extractCount = 0;
      const countingExtractor: CandidateExtractor = () => {
        extractCount++;
        return [];
      };

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: countingExtractor,
      });
      reflector.scheduleReflection("abcdef1234", GENERAL_SCOPE);
      await reflector.awaitSettled("abcdef1234");

      expect(extractCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Unsafe candidate quarantine
  // -------------------------------------------------------------------------

  describe("unsafe candidate quarantine", () => {
    it("quarantines a candidate containing a secret and does not write memory", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the api key is sk-abcdefghijklmnopqrstuvwxyz1234567890" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const metrics = new MetricsStore(tmp, "abcdef1234");
      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        metrics,
        extractor: fixedExtractor([
          makeCandidate({ summary: "the api key is sk-abcdefghijklmnopqrstuvwxyz1234567890" }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      // Memory untouched.
      expect(store.read("general").body).toBe("");
      // Quarantine has one record with reason "unsafe".
      const records = readQuarantine(tmp);
      expect(records).toHaveLength(1);
      const record = records[0] as { reason: string; preview: string };
      expect(record.reason).toBe("unsafe");
      expect(record.preview).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
      // Cursor still advanced (the candidate was handled — quarantined).
      expect(readCursor(tmp, "abcdef1234")!.processedLines).toBe(1);

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryReflectionCandidateTotal).toBe(1);
      expect(summary.memoryReflectionQuarantineTotal).toBe(1);
      expect(summary.memoryReflectionPersistedTotal).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Low-confidence quarantine
  // -------------------------------------------------------------------------

  describe("low-confidence quarantine", () => {
    it("quarantines a candidate below the confidence threshold", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "maybe the project uses TypeScript" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const metrics = new MetricsStore(tmp, "abcdef1234");
      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        metrics,
        extractor: fixedExtractor([
          makeCandidate({ summary: "maybe the project uses TypeScript", confidence: 0.2 }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      expect(store.read("general").body).toBe("");
      const records = readQuarantine(tmp);
      expect(records).toHaveLength(1);
      expect((records[0] as { reason: string }).reason).toBe("low_confidence");

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryReflectionCandidateTotal).toBe(1);
      expect(summary.memoryReflectionQuarantineTotal).toBe(1);
      expect(summary.memoryReflectionPersistedTotal).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Procedural-noise skip
  // -------------------------------------------------------------------------

  describe("procedural-noise skip", () => {
    it("skips a procedural command without writing memory or a quarantine record", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "run the tests now" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const metrics = new MetricsStore(tmp, "abcdef1234");
      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        metrics,
        extractor: fixedExtractor([makeCandidate({ summary: "run the tests now" })]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      expect(store.read("general").body).toBe("");
      expect(readQuarantine(tmp)).toHaveLength(0);
      // Cursor still advanced — the noise candidate was handled (skipped).
      expect(readCursor(tmp, "abcdef1234")!.processedLines).toBe(1);

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryReflectionCandidateTotal).toBe(1);
      expect(summary.memoryReflectionQuarantineTotal).toBe(1);
    });

    it("skips greeting/small-talk without a quarantine record", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "hello" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const metrics = new MetricsStore(tmp, "abcdef1234");
      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        metrics,
        extractor: fixedExtractor([makeCandidate({ summary: "hello" })]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      expect(store.read("general").body).toBe("");
      expect(readQuarantine(tmp)).toHaveLength(0);

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryReflectionCandidateTotal).toBe(1);
      expect(summary.memoryReflectionQuarantineTotal).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Safe candidate write
  // -------------------------------------------------------------------------

  describe("safe candidate write", () => {
    it("writes a safe high-confidence candidate to the active memory scope", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the project uses TypeScript" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({ summary: "the project uses TypeScript", confidence: 0.85 }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const body = store.read("general").body;
      expect(body).toContain("the project uses TypeScript");
      // Entry has metadata.
      const parsed = parseEntryMetadata(body);
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.category).toBe("project_fact");
      expect(parsed!.metadata.confidence).toBe(0.85);
      expect(parsed!.metadata.source_session).toBe("abcdef1234");
    });

    it("records reflection counters to metrics when provided", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the project uses TypeScript" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });
      const metrics = new MetricsStore(tmp, "abcdef1234");

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        metrics,
        extractor: fixedExtractor([
          makeCandidate({ summary: "the project uses TypeScript", confidence: 0.85 }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryReflectionCandidateTotal).toBe(1);
      expect(summary.memoryReflectionPersistedTotal).toBe(1);
      expect(summary.memoryReflectionQuarantineTotal).toBe(0);
    });

    it("writes a user preference candidate to user.md", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({
            target: "user",
            category: "preference",
            confidence: 0.8,
            summary: "I prefer concise summaries",
          }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      expect(store.read("user").body).toContain("I prefer concise summaries");
      expect(store.read("general").body).toBe("");
    });

    it("writes to topic scope when active scope is a topic", async () => {
      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the project uses TypeScript" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({ summary: "the project uses TypeScript" }),
        ]),
      });
      await reflector.reflect("abcdef1234", TOPIC_SCOPE);

      expect(store.read({ topic: { chatId: -100, topicId: 42 } }).body).toContain(
        "the project uses TypeScript",
      );
      expect(store.read("general").body).toBe("");
    });

    it("quarantines a safe candidate when the write fails due to cap overflow", async () => {
      // Fill user.md to near-cap so the reflected entry won't fit.
      // user.md cap is 2000 chars. A metadata-bearing entry is ~250+ chars.
      const filler = "x".repeat(1950);
      await store.add("user", filler);

      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries with test output evidence" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({
            target: "user",
            category: "preference",
            confidence: 0.85,
            summary: "I prefer concise summaries with test output evidence",
          }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      // The candidate was not written (cap overflow).
      const body = store.read("user").body;
      expect(body).not.toContain("I prefer concise summaries with test output evidence");
      // The candidate was quarantined for review, not silently dropped.
      const records = readQuarantine(tmp);
      expect(records).toHaveLength(1);
      expect((records[0] as { reason: string }).reason).toBe("review");
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate consolidation
  // -------------------------------------------------------------------------

  describe("duplicate consolidation", () => {
    it("updates an existing near-duplicate entry instead of appending", async () => {
      // Seed an existing entry in user.md.
      await store.add(
        "user",
        "<!-- memory: category=preference confidence=0.8 created_at=2026-07-01T00:00:00.000Z updated_at=2026-07-01T00:00:00.000Z source_session=s_old source_role=user -->\nI prefer concise summaries",
      );

      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries with test output" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({
            target: "user",
            category: "preference",
            confidence: 0.85,
            summary: "I prefer concise summaries with test output",
            source: { sessionId: "s_new", lineRange: [0, 0], sourceRole: "user" },
          }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const body = store.read("user").body;
      // Only one entry — not duplicated.
      const entries = body.split("\n§\n");
      expect(entries).toHaveLength(1);
      // The entry body was updated.
      expect(body).toContain("I prefer concise summaries with test output");
      // Original source_session preserved; updated_source_session set.
      const parsed = parseEntryMetadata(entries[0]!);
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.source_session).toBe("s_old");
      expect(parsed!.metadata.updated_source_session).toBe("s_new");
      // created_at preserved from the original.
      expect(parsed!.metadata.created_at).toBe("2026-07-01T00:00:00.000Z");
      // updated_at changed.
      expect(parsed!.metadata.updated_at).not.toBe("2026-07-01T00:00:00.000Z");
    });

    it("appends a distinct candidate as a new entry", async () => {
      await store.add("user", "I prefer concise summaries");

      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the project uses Bun" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({
            target: "user",
            category: "project_fact",
            confidence: 0.8,
            summary: "the project uses Bun",
          }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const body = store.read("user").body;
      const entries = body.split("\n§\n");
      expect(entries).toHaveLength(2);
      expect(body).toContain("the project uses Bun");
    });

    // S7: a shorter near-duplicate candidate must not overwrite a longer,
    // more detailed existing entry. The existing body is preserved and only
    // entry metadata is refreshed.
    it("preserves the longer existing body when a shorter candidate is a near-duplicate", async () => {
      const detailed = "I prefer concise summaries with test output evidence";
      await store.add(
        "user",
        "<!-- memory: category=preference confidence=0.8 created_at=2026-07-01T00:00:00.000Z updated_at=2026-07-01T00:00:00.000Z source_session=s_old source_role=user -->\n" +
          detailed,
      );

      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "I prefer concise summaries" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({
            target: "user",
            category: "preference",
            confidence: 0.85,
            summary: "I prefer concise summaries",
            source: { sessionId: "s_new", lineRange: [0, 0], sourceRole: "user" },
          }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const body = store.read("user").body;
      const entries = body.split("\n§\n");
      expect(entries).toHaveLength(1);
      // The detailed body is preserved — not truncated to the shorter summary.
      expect(body).toContain(detailed);
      // Metadata was still refreshed.
      const parsed = parseEntryMetadata(entries[0]!);
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.updated_source_session).toBe("s_new");
      expect(parsed!.metadata.updated_at).not.toBe("2026-07-01T00:00:00.000Z");
    });

    // S3: consolidation must run atomically under the scope lock so an
    // explicit write landing between the reflector's read and write is not
    // silently overwritten. We simulate the race by interleaving an
    // explicit store.add inside the consolidate callback window — the
    // explicit write commits first, then the reflector's consolidate reads
    // the post-write body under the lock and preserves it.
    it("does not lose an explicit write that lands before the locked consolidate read", async () => {
      await store.add("user", "I prefer concise summaries");

      appendTranscript(tmp, "abcdef1234", [
        { role: "user", text: "the project uses Bun" },
      ]);
      writeCursor(tmp, "abcdef1234", { processedLines: 0, lastReflectedAt: "2026-07-01T00:00:00.000Z" });

      // Patch the store's consolidate to inject an explicit write before
      // the locked read-modify-write runs. If the reflector held a stale
      // unlocked snapshot, the explicit entry would be overwritten.
      const originalConsolidate = store.consolidate.bind(store);
      let injected = false;
      store.consolidate = async (scope, fn) => {
        if (!injected) {
          injected = true;
          // An explicit memory_write lands on the same scope before the
          // reflector's locked read.
          await store.add("user", "explicit fact from the user turn");
        }
        return originalConsolidate(scope, fn);
      };

      const reflector = new MemoryReflector({
        goblinHome: tmp,
        store,
        extractor: fixedExtractor([
          makeCandidate({
            target: "user",
            category: "project_fact",
            confidence: 0.8,
            summary: "the project uses Bun",
          }),
        ]),
      });
      await reflector.reflect("abcdef1234", GENERAL_SCOPE);

      const body = store.read("user").body;
      // The explicit write survives — not silently overwritten.
      expect(body).toContain("explicit fact from the user turn");
      // The reflected candidate is also present.
      expect(body).toContain("the project uses Bun");
    });
  });

  // -------------------------------------------------------------------------
  // Default deterministic extractor
  // -------------------------------------------------------------------------

  describe("defaultCandidateExtractor", () => {
    it("extracts a preference candidate from a user message", () => {
      const entries = [makeTranscriptLine("user", "I prefer terse summaries", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("preference");
      expect(candidates[0]!.target).toBe("user");
      expect(candidates[0]!.confidence).toBeGreaterThan(0.5);
    });

    it("extracts a decision candidate", () => {
      const entries = [makeTranscriptLine("user", "let's decide on using Bun", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("decision");
      expect(candidates[0]!.target).toBe("memory");
    });

    it("extracts a project fact from an assistant message", () => {
      const entries = [makeTranscriptLine("assistant", "the project uses TypeScript and Bun", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("project_fact");
    });

    it("extracts a gotcha", () => {
      const entries = [makeTranscriptLine("user", "watch out for the timezone bug in date parsing", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("gotcha");
    });

    it("extracts a convention", () => {
      const entries = [makeTranscriptLine("user", "we always run bun test before committing", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("convention");
    });

    it("extracts an explicit commitment", () => {
      const entries = [makeTranscriptLine("user", "I commit to reviewing invoices every Friday", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("commitment");
      expect(candidates[0]!.target).toBe("memory");
      expect(candidates[0]!.confidence).toBeGreaterThan(0.5);
    });

    it("extracts an explicit commitment from 'commitment:' phrasing", () => {
      const entries = [makeTranscriptLine("user", "commitment: ship the release notes by Monday", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("commitment");
    });

    it("extracts an explicit standing order", () => {
      const entries = [makeTranscriptLine("user", "standing order: remind me to check backups weekly", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("standing_order");
      expect(candidates[0]!.target).toBe("memory");
      expect(candidates[0]!.confidence).toBeGreaterThan(0.5);
    });

    it("extracts a standing order from 'always remind me to' phrasing", () => {
      const entries = [makeTranscriptLine("user", "always remind me to renew the domain", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("standing_order");
    });

    it("does NOT infer a commitment from vague intent", () => {
      const entries = [makeTranscriptLine("user", "I should probably check backups sometime", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      const durable = candidates.filter(
        (c) => c.category === "commitment" || c.category === "standing_order",
      );
      expect(durable).toHaveLength(0);
    });

    it("does NOT infer a commitment from an ordinary task request", () => {
      const entries = [makeTranscriptLine("user", "can you check the backups later?", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      const durable = candidates.filter(
        (c) => c.category === "commitment" || c.category === "standing_order",
      );
      expect(durable).toHaveLength(0);
    });

    it("extracts a correction as a preference", () => {
      const entries = [makeTranscriptLine("user", "no, actually I meant concise summaries", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.category).toBe("preference");
    });

    it("produces no candidates for procedural commands", () => {
      const entries = [makeTranscriptLine("user", "run the tests now", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(0);
    });

    it("produces no candidates for toolResult entries", () => {
      const entries = [makeTranscriptLine("toolResult", "I prefer concise summaries", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(0);
    });

    it("produces no candidates for tiny fragments", () => {
      const entries = [makeTranscriptLine("user", "ok", 0)];
      const candidates = defaultCandidateExtractor(entries, { sessionId: "abcdef1234" });
      expect(candidates).toHaveLength(0);
    });
  });
});
