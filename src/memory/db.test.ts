import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "./db.ts";
import { MEMORY_SCHEMA_VERSION } from "./schema.ts";

const PRE_V2_ENTRIES_DDL = `
CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_session TEXT,
  updated_source_session TEXT,
  source_role TEXT,
  category TEXT,
  confidence REAL,
  origin TEXT NOT NULL,
  promoted_at INTEGER,
  chat_id TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER
);

CREATE VIRTUAL TABLE memory_index_fts USING fts5 (
  text,
  entry_id,
  scope,
  entry_kind,
  chat_id
);
`;

const HISTORICAL_V4_ENTRIES_DDL = PRE_V2_ENTRIES_DDL.replace(
  "  updated_at INTEGER NOT NULL,\n",
  "  updated_at INTEGER NOT NULL,\n  display_order INTEGER NOT NULL DEFAULT 0,\n",
);

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

  it("upgrades the historical version-4 entry schema without losing rows, FTS data, or display order", () => {
    if (!tmp) throw new Error("tmp directory not initialized");
    const path = join(tmp, "prior.sqlite");
    const prior = new Database(path, { create: true });
    prior.exec(HISTORICAL_V4_ENTRIES_DDL);
    prior
      .query("INSERT INTO memory_meta (key, value, updated_at) VALUES ('schema_version', '4', 1)")
      .run();

    const insertEntry = prior.query(`
      INSERT INTO memory_entries
        (id, scope, entry_kind, text, created_at, updated_at, origin, chat_id, display_order)
      VALUES
        ($id, $scope, $entry_kind, $text, $created_at, $updated_at, $origin, $chat_id, $display_order)
    `);
    const entries = [
      { id: "a", scope: "general", entryKind: "curated", text: "first", createdAt: 100, chatId: null, displayOrder: 7 },
      { id: "b", scope: "general", entryKind: "curated", text: "second", createdAt: 200, chatId: null, displayOrder: 3 },
    ] as const;
    for (const entry of entries) {
      insertEntry.run({
        $id: entry.id,
        $scope: entry.scope,
        $entry_kind: entry.entryKind,
        $text: entry.text,
        $created_at: entry.createdAt,
        $updated_at: entry.createdAt + 1,
        $origin: "user",
        $chat_id: entry.chatId,
        $display_order: entry.displayOrder,
      });
      prior
        .query(`
          INSERT INTO memory_index_fts (text, entry_id, scope, entry_kind, chat_id)
          VALUES ($text, $id, $scope, $entry_kind, $chat_id)
        `)
        .run({
          $text: entry.text,
          $id: entry.id,
          $scope: entry.scope,
          $entry_kind: entry.entryKind,
          $chat_id: entry.chatId,
        });
    }
    prior.close();

    db = new MemoryDatabase(path);

    expect(db.getMeta("schema_version")).toBe(String(MEMORY_SCHEMA_VERSION));
    expect(
      db.database
        .query<{ id: string; text: string; display_order: number }, []>(
          "SELECT id, text, display_order FROM memory_entries ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "a", text: "first", display_order: 7 },
      { id: "b", text: "second", display_order: 3 },
    ]);
    expect(
      db.database
        .query<{ name: string }, []>("PRAGMA table_info(memory_entries)")
        .all()
        .some((column) => column.name === "source_surface_id"),
    ).toBe(true);
    expect(
      db.database
        .query<{ entry_id: string; text: string }, []>(
          "SELECT entry_id, text FROM memory_index_fts ORDER BY entry_id",
        )
        .all(),
    ).toEqual(entries
      .map((entry) => ({ entry_id: entry.id, text: entry.text }))
      .sort((left, right) => left.entry_id.localeCompare(right.entry_id)));
  });

  it("backfills deterministic display order when upgrading a schema that lacks the column", () => {
    if (!tmp) throw new Error("tmp directory not initialized");
    const path = join(tmp, "pre-display-order.sqlite");
    const prior = new Database(path, { create: true });
    prior.exec(PRE_V2_ENTRIES_DDL);
    prior
      .query("INSERT INTO memory_meta (key, value, updated_at) VALUES ('schema_version', '1', 1)")
      .run();
    const insert = prior.query(`
      INSERT INTO memory_entries
        (id, scope, entry_kind, text, created_at, updated_at, origin)
      VALUES ($id, 'general', 'curated', $id, $created_at, $created_at, 'user')
    `);
    insert.run({ $id: "b", $created_at: 100 });
    insert.run({ $id: "a", $created_at: 100 });
    insert.run({ $id: "c", $created_at: 50 });
    prior.close();

    db = new MemoryDatabase(path);

    expect(
      db.database
        .query<{ id: string; display_order: number }, []>(
          "SELECT id, display_order FROM memory_entries ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "a", display_order: 1 },
      { id: "b", display_order: 2 },
      { id: "c", display_order: 0 },
    ]);
  });

  it("rejects a schema version newer than supported without modifying the database", () => {
    if (!tmp) throw new Error("tmp directory not initialized");
    const path = join(tmp, "future.sqlite");
    const future = new Database(path, { create: true });
    future.exec(`
      CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      INSERT INTO memory_meta (key, value, updated_at)
      VALUES ('schema_version', '${MEMORY_SCHEMA_VERSION + 1}', 1);
    `);
    future.close();

    expect(() => new MemoryDatabase(path)).toThrow(
      `memory schema version ${MEMORY_SCHEMA_VERSION + 1} is newer than supported ${MEMORY_SCHEMA_VERSION}`,
    );

    const check = new Database(path);
    try {
      expect(
        check
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      check.close();
    }
  });

  it("close() shuts down without throwing", () => {
    const d = createDb();
    expect(() => d.close()).not.toThrow();
  });

  it("readonly mode opens an existing database without running migrations", () => {
    if (!tmp) throw new Error("tmp directory not initialized");
    const path = join(tmp, "readonly.sqlite");
    const created = new MemoryDatabase(path);
    created.setMeta("test-key", "test-value");
    created.close();

    const ro = new MemoryDatabase(path, { readonly: true });
    expect(ro.getMeta("test-key")).toBe("test-value");
    expect(() => ro.setMeta("other", "value")).toThrow("readonly");
    ro.close();
  });

  it("readonly mode rejects a missing database file", () => {
    if (!tmp) throw new Error("tmp directory not initialized");
    const path = join(tmp, "nonexistent.sqlite");
    expect(() => new MemoryDatabase(path, { readonly: true })).toThrow();
  });
});
