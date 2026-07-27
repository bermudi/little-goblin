import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { TranscriptIndexer } from "./transcript-index.ts";
import { DreamingPipeline } from "./dreaming.ts";
import { searchMemoryEntries } from "./search.ts";
import { sessionDir, transcriptPath } from "../sessions/paths.ts";
import { surfaceId, topicSurface } from "../surface.ts";
import type { TranscriptEntry } from "../sessions/transcript.ts";
import type { PersonaPolicy } from "./search.ts";

const SESSION_ID = "abcdef1234";
const MAIN_PERSONA: PersonaPolicy = { kind: "all" };

describe("transcript provenance end-to-end fixture", () => {
  let tmp: string;
  let store: MemoryStore;
  let indexer: TranscriptIndexer;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-prov-e2e-"));
    store = new MemoryStore(tmp);
    indexer = new TranscriptIndexer(tmp, store);
  });

  afterEach(() => {
    store.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(entries: TranscriptEntry[]): void {
    const dir = sessionDir(tmp, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      transcriptPath(tmp, SESSION_ID),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  it("indexes two-surface chat provenance, excludes unresolved history by default, and promotes to correct scopes", async () => {
    const surfaceA = surfaceId(topicSurface("private", 100, 1));
    const surfaceB = surfaceId(topicSurface("private", 200, 1));

    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "uniqueA message from chat one surface.",
        sourceSurfaceId: surfaceA,
      },
      {
        ts: "2026-07-04T12:00:01.000Z",
        role: "assistant",
        content: "uniqueB message reply from chat two surface.",
        sourceSurfaceId: surfaceB,
      },
      {
        ts: "2026-07-04T12:00:02.000Z",
        role: "user",
        content: "legacyL message from an unknown chat without provenance.",
      },
    ];
    writeTranscript(entries);

    // 1. Index the transcript. Each entry should be chunked and indexed under
    //    its provenance-derived chat_id, while unresolved provenance stays null.
    const sync = await indexer.sync(10000);
    expect(sync.indexed).toBe(1);
    expect(sync.inserted).toBeGreaterThan(0);

    const rows = store.db.database
      .query<
        { chat_id: string | null; source_surface_id: string | null },
        { $scope: string }
      >(
        `SELECT DISTINCT chat_id, source_surface_id
         FROM memory_entries
         WHERE scope = $scope
         ORDER BY created_at, id`,
      )
      .all({ $scope: `transcript/${SESSION_ID}` });

    const bySource = new Map(
      rows
        .filter((r) => r.source_surface_id !== null)
        .map((r) => [r.source_surface_id!, r.chat_id]),
    );
    expect(bySource.get(surfaceA)).toBe("100");
    expect(bySource.get(surfaceB)).toBe("200");
    expect(rows.some((r) => r.source_surface_id === null && r.chat_id === null))
      .toBe(true);

    // 2. Default search for chat 100 only returns the surface-A entry; the
    //    unresolved legacy row and the other-chat row are excluded.
    const activeScopeA = { chatId: 100, topicScope: { topicId: 1 } as const };
    const defaultSearch = await searchMemoryEntries({
      store,
      activeScope: activeScopeA,
      persona: MAIN_PERSONA,
      query: "message",
      corpus: "transcripts",
    });
    const defaultSessionIds = defaultSearch.results.map((r) => r.sessionId);
    expect(defaultSessionIds).toEqual([SESSION_ID]);
    expect(defaultSearch.results).toHaveLength(1);
    expect(defaultSearch.results[0]!.text).toContain("uniqueA");

    // 3. Cross-chat search includes both provenance-bearing rows and the
    //    unresolved legacy row.
    const allChatsSearch = await searchMemoryEntries({
      store,
      activeScope: activeScopeA,
      persona: MAIN_PERSONA,
      query: "message",
      corpus: "transcripts",
      allChats: true,
    });
    expect(allChatsSearch.results).toHaveLength(3);

    // 4. Light sleep promotes each provenance-bearing source to its projected
    //    scope, while unresolved provenance falls back to general.
    const pipeline = new DreamingPipeline({
      goblinHome: tmp,
      store,
      lookbackHours: 0,
      extractor: (lines) =>
        lines.map((line) => ({
          target: "memory" as const,
          category: "fact" as const,
          confidence: 0.9,
          text: line.text,
          source: {
            sessionId: SESSION_ID,
            lineRange: [line.index, line.index] as [number, number],
            sourceRole:
              line.role === "user"
                ? ("user" as const)
                : line.role === "assistant"
                  ? ("assistant" as const)
                  : ("system" as const),
          },
        })),
    });

    store.db.setMeta(
      `dreaming_cursor:${SESSION_ID}`,
      JSON.stringify({ processedLines: 0, lastDreamedAt: new Date().toISOString() }),
    );

    await pipeline.runLightSleep(SESSION_ID);

    const memoryRows = store.db.database
      .query<
        { text: string; scope: string },
        Record<string, never>
      >(
        "SELECT text, scope FROM memory_entries WHERE entry_kind = 'memory' ORDER BY created_at, id",
      )
      .all({});

    const byText = new Map(memoryRows.map((r) => [r.text, r.scope]));
    expect(byText.get("uniqueA message from chat one surface.")).toBe("topics/100/1");
    expect(byText.get("uniqueB message reply from chat two surface.")).toBe("topics/200/1");
    expect(byText.get("legacyL message from an unknown chat without provenance.")).toBe("general");
  });
});
