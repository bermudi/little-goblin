import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    engine.close();
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

  it("waits for markdown import before purging the legacy transcript index", async () => {
    const generalDir = join(memoryDir(tmp), "general");
    mkdirSync(generalDir, { recursive: true });
    writeFileSync(join(generalDir, "memory.md"), "legacy memory", "utf-8");

    let releaseEmbeddings: ((result: Map<string, Float32Array | null>) => void) | undefined;
    const embeddings = spyOn(engine.embeddingProvider, "embedEntries").mockImplementation(
      () =>
        new Promise<Map<string, Float32Array | null>>((resolve) => {
          releaseEmbeddings = resolve;
        }),
    );
    const purge = spyOn(engine.readStore, "migrateTranscriptProvenanceIndex");

    try {
      const migration = engine.migrate();
      await Promise.resolve();

      expect(embeddings).toHaveBeenCalledTimes(1);
      expect(purge).not.toHaveBeenCalled();
      if (releaseEmbeddings === undefined) throw new Error("embedding migration did not begin");

      releaseEmbeddings(new Map());
      await expect(migration).resolves.toBe(true);
      expect(purge).toHaveBeenCalledTimes(1);
    } finally {
      embeddings.mockRestore();
      purge.mockRestore();
    }
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
