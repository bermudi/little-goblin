import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine } from "./engine.ts";
import { MemoryStore } from "./store.ts";
import { memoryDir, memoryDbPath } from "./paths.ts";

// Keep the global budget high enough that these tests never trip over it.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "100000";

describe("MemoryEngine", () => {
  let tmp: string;
  let engine: MemoryEngine;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-engine-"));
    engine = new MemoryEngine(tmp);
  });

  afterEach(() => {
    engine.readStore.close();
    ((engine.dreaming as unknown) as { store: { close: () => void } }).store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creation creates state/memory/", () => {
    expect(existsSync(memoryDir(tmp))).toBe(true);
    expect(existsSync(memoryDbPath(tmp))).toBe(true);
  });

  it("migrate returns false when no markdown files exist and sets migrated_at meta", async () => {
    // First call marks migration complete (sets migrated_at); subsequent calls
    // are a no-op and return false because there is nothing to migrate.
    await engine.migrate();
    const result = await engine.migrate();
    expect(result).toBe(false);
    expect(engine.readStore.db.getMeta("migrated_at")).toBeDefined();
  });

  it("syncTranscripts returns zeros when no sessions exist", async () => {
    const result = await engine.syncTranscripts();
    expect(result).toEqual({ indexed: 0, removed: 0, inserted: 0 });
  });

  it("reindexIfNeeded completes with no entries", async () => {
    await expect(engine.reindexIfNeeded()).resolves.toBeUndefined();
  });

  it("newStore returns a MemoryStore sharing the same EmbeddingProvider", () => {
    const store = engine.newStore();
    expect(store).toBeInstanceOf(MemoryStore);
    expect(store.embeddingProvider).toBe(engine.embeddingProvider);
    store.close();
  });

  it("newStore-created stores can be closed", () => {
    const store = engine.newStore();
    expect(() => store.close()).not.toThrow();
  });
});
