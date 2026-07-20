import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "./db.ts";
import { MEMORY_SCHEMA_VERSION } from "./schema.ts";

describe("MemoryDatabase", () => {
  let db: MemoryDatabase | undefined;
  let tmp: string | undefined;

  function createDb(env?: { vector?: string; text?: string }): MemoryDatabase {
    if (env?.vector !== undefined) process.env.GOBLIN_MEMORY_VECTOR_WEIGHT = env.vector;
    if (env?.text !== undefined) process.env.GOBLIN_MEMORY_TEXT_WEIGHT = env.text;

    try {
      return new MemoryDatabase(":memory:");
    } catch {
      if (!tmp) throw new Error("tmp directory not initialized");
      return new MemoryDatabase(join(tmp, "memory.sqlite"));
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-db-"));
    delete process.env.GOBLIN_MEMORY_VECTOR_WEIGHT;
    delete process.env.GOBLIN_MEMORY_TEXT_WEIGHT;
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
    delete process.env.GOBLIN_MEMORY_VECTOR_WEIGHT;
    delete process.env.GOBLIN_MEMORY_TEXT_WEIGHT;
  });

  it("database getter returns a usable Database", () => {
    db = createDb();
    expect(db.database.query<{ one: number }, []>("SELECT 1 AS one").all()).toEqual([{ one: 1 }]);
  });

  it("setMeta/getMeta roundtrip", () => {
    db = createDb();
    db.setMeta("test-key", "test-value");
    expect(db.getMeta("test-key")).toBe("test-value");
  });

  it("getMeta returns undefined for missing keys", () => {
    db = createDb();
    expect(db.getMeta("not-set")).toBeUndefined();
  });

  describe("weights", () => {
    it("falls back to defaults when env vars are unset", () => {
      db = createDb();
      expect(db.weights).toEqual({ vectorWeight: 0.7, textWeight: 0.3 });
    });

    it("clamps out-of-range env values to [0, 1]", () => {
      db = createDb({ vector: "2.5", text: "-0.5" });
      expect(db.weights).toEqual({ vectorWeight: 1, textWeight: 0 });
    });

    it("falls back to defaults when clamped weights sum to zero", () => {
      db = createDb({ vector: "0", text: "0" });
      expect(db.weights).toEqual({ vectorWeight: 0.7, textWeight: 0.3 });
    });

    it("uses valid env values within [0, 1]", () => {
      db = createDb({ vector: "0.9", text: "0.1" });
      expect(db.weights).toEqual({ vectorWeight: 0.9, textWeight: 0.1 });
    });
  });

  it("schema migrations run and set schema_version meta", () => {
    db = createDb();
    expect(db.getMeta("schema_version")).toBe(String(MEMORY_SCHEMA_VERSION));
    const tables = db.database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
      )
      .all();
    expect(tables.length).toBe(1);
  });

  it("close() shuts down without throwing", () => {
    const d = createDb();
    expect(() => d.close()).not.toThrow();
  });
});
