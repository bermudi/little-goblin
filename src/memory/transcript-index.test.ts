import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptIndexer } from "./transcript-index.ts";
import { MemoryStore } from "./store.ts";
import { MemoryBudget } from "./budget.ts";
import { surfaceId, dmSurface, topicSurface } from "../surface.ts";
import type { TranscriptEntry } from "../sessions/transcript.ts";

const sessionId = "abcdef1234";

describe("TranscriptIndexer", () => {
  let tmp: string;
  let store: MemoryStore;
  let indexer: TranscriptIndexer;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-transcript-"));
    store = new MemoryStore(tmp, undefined, {
      budget: new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "1000000" }),
    });
    indexer = new TranscriptIndexer(tmp, store);
  });

  afterEach(() => {
    store.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(entries: TranscriptEntry[]): void {
    const dir = join(tmp, "state", "sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    // Legacy session state with a non-zero chatId is still required by the
    // discoverer so the session is not treated as internal.
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        id: sessionId,
        createdAt: "2026-07-04T12:00:00.000Z",
        chatId: 123,
        executionEnvironment: { kind: "personal" },
      }),
    );
    writeFileSync(
      join(dir, "transcript.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  function queryTranscriptRows(): Array<{
    text: string;
    scope: string;
    entry_kind: string;
    chat_id: string | null;
    source_surface_id: string | null;
    source_session: string | null;
    source_role: string | null;
  }> {
    const scope = `transcript/${sessionId}`;
    return store.db.database
      .query<
        {
          text: string;
          scope: string;
          entry_kind: string;
          chat_id: string | null;
          source_surface_id: string | null;
          source_session: string | null;
          source_role: string | null;
        },
        { $scope: string }
      >(
        "SELECT text, scope, entry_kind, chat_id, source_surface_id, source_session, source_role FROM memory_entries WHERE scope = $scope ORDER BY created_at, id",
      )
      .all({ $scope: scope });
  }

  it("indexes a session transcript and derives chat_id from per-entry sourceSurfaceId", async () => {
    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "Hello world, this is a user message.",
        sourceSurfaceId: surfaceId(dmSurface(123)),
      },
      {
        ts: "2026-07-04T12:00:01.000Z",
        role: "assistant",
        content: "Assistant reply here with enough characters for the test.",
        sourceSurfaceId: surfaceId(dmSurface(123)),
      },
    ];
    writeTranscript(entries);

    const first = await indexer.sync(10000);
    expect(first.indexed).toBe(1);
    expect(first.inserted).toBe(2);
    expect(first.removed).toBe(0);

    const rows = queryTranscriptRows();
    expect(rows.length).toBe(2);
    expect(rows[0]!.scope).toBe(`transcript/${sessionId}`);
    expect(rows[0]!.entry_kind).toBe("transcript");
    expect(rows[0]!.chat_id).toBe("123");
    expect(rows[0]!.source_surface_id).toBe(surfaceId(dmSurface(123)));
    expect(rows[0]!.source_session).toBe(sessionId);
    expect(rows[0]!.source_role).toBe("user");
    expect(rows[0]!.text).toContain("Hello world, this is a user message.");
    expect(rows[1]!.source_role).toBe("assistant");
    expect(rows[1]!.text).toContain(
      "Assistant reply here with enough characters for the test.",
    );

    const second = await indexer.sync(10000);
    expect(second.indexed).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.removed).toBe(0);
  });

  it("indexes mixed-chat rows inside a single transcript scope", async () => {
    const surfaceA = surfaceId(topicSurface("private", -100, 1));
    const surfaceB = surfaceId(topicSurface("private", -200, 2));
    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "Message from chat A with enough text to index.",
        sourceSurfaceId: surfaceA,
      },
      {
        ts: "2026-07-04T12:00:01.000Z",
        role: "assistant",
        content: "Reply from chat B with enough text to index.",
        sourceSurfaceId: surfaceB,
      },
    ];
    writeTranscript(entries);

    const result = await indexer.sync(10000);
    expect(result.indexed).toBe(1);
    expect(result.inserted).toBe(2);

    const rows = queryTranscriptRows();
    expect(rows[0]!.chat_id).toBe("-100");
    expect(rows[0]!.source_surface_id).toBe(surfaceA);
    expect(rows[1]!.chat_id).toBe("-200");
    expect(rows[1]!.source_surface_id).toBe(surfaceB);
    expect(rows.every((r) => r.scope === `transcript/${sessionId}`)).toBe(true);
  });

  it("leaves chat_id null for legacy entries without sourceSurfaceId", async () => {
    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "Legacy user message without provenance still readable.",
      },
    ];
    writeTranscript(entries);

    const result = await indexer.sync(10000);
    expect(result.indexed).toBe(1);
    expect(result.inserted).toBe(1);

    const rows = queryTranscriptRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.chat_id).toBeNull();
    expect(rows[0]!.source_surface_id).toBeNull();
    expect(rows[0]!.text).toContain("Legacy user message without provenance still readable.");
  });

  it("treats invalid sourceSurfaceId as null provenance", async () => {
    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "Message with a malformed provenance value.",
        sourceSurfaceId: "not-a-valid-surface-id" as ReturnType<typeof surfaceId>,
      },
    ];
    writeTranscript(entries);

    const result = await indexer.sync(10000);
    expect(result.indexed).toBe(1);
    expect(result.inserted).toBe(1);

    const rows = queryTranscriptRows();
    expect(rows[0]!.chat_id).toBeNull();
    expect(rows[0]!.source_surface_id).toBeNull();
  });

  it("removes indexed chunks when a transcript file is deleted", async () => {
    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "Temporary message that will be deleted along with the file.",
        sourceSurfaceId: surfaceId(dmSurface(123)),
      },
    ];
    writeTranscript(entries);
    await indexer.sync(10000);

    const dir = join(tmp, "state", "sessions", sessionId);
    rmSync(dir, { recursive: true, force: true });

    const result = await indexer.sync(10000);
    expect(result.removed).toBe(1);

    const rows = queryTranscriptRows();
    expect(rows.length).toBe(0);
  });

  it("reindexes a changed transcript with updated provenance", async () => {
    const firstSurface = surfaceId(dmSurface(123));
    writeTranscript([
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "First version of the message.",
        sourceSurfaceId: firstSurface,
      },
    ]);
    await indexer.sync(10000);

    const secondSurface = surfaceId(dmSurface(456));
    writeTranscript([
      {
        ts: "2026-07-04T12:00:01.000Z",
        role: "user",
        content: "Second version with different provenance.",
        sourceSurfaceId: secondSurface,
      },
    ]);

    const result = await indexer.sync(10000);
    expect(result.indexed).toBe(1);

    const rows = queryTranscriptRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.chat_id).toBe("456");
    expect(rows[0]!.source_surface_id).toBe(secondSurface);
  });
});
