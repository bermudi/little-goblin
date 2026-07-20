import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptIndexer } from "./transcript-index.ts";
import { MemoryStore } from "./store.ts";
import { MemoryBudget } from "./budget.ts";
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

  it("indexes a session transcript and stores snippets", async () => {
    const dir = join(tmp, "state", "sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ chatId: 123 }));

    const entries: TranscriptEntry[] = [
      {
        ts: "2026-07-04T12:00:00.000Z",
        role: "user",
        content: "Hello world, this is a user message.",
      },
      {
        ts: "2026-07-04T12:00:01.000Z",
        role: "assistant",
        content: "Assistant reply here with enough characters for the test.",
      },
    ];
    writeFileSync(
      join(dir, "transcript.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const first = await indexer.sync(10000);
    expect(first.indexed).toBe(1);
    expect(first.inserted).toBe(2);
    expect(first.removed).toBe(0);

    const scope = `transcript/${sessionId}`;
    const rows = store.db.database
      .query<
        {
          text: string;
          scope: string;
          entry_kind: string;
          chat_id: string | null;
          source_session: string | null;
          source_role: string | null;
        },
        { $scope: string }
      >(
        "SELECT text, scope, entry_kind, chat_id, source_session, source_role FROM memory_entries WHERE scope = $scope ORDER BY created_at, id",
      )
      .all({ $scope: scope });

    expect(rows.length).toBe(2);
    expect(rows[0]!.scope).toBe(scope);
    expect(rows[0]!.entry_kind).toBe("transcript");
    expect(rows[0]!.chat_id).toBe("123");
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
});
