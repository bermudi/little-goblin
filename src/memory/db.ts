import { Database } from "bun:sqlite";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { log } from "../log.ts";
import { DDL, INDEX_DDL, MEMORY_SCHEMA_VERSION } from "./schema.ts";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_PROVIDER = "openai";

function clampWeight(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export class MemoryDatabase {
  private db: Database;
  private vectorWeight: number;
  private textWeight: number;
  private readonly readOnly: boolean;

  constructor(dbPath: string, options?: { readonly?: boolean }) {
    this.readOnly = options?.readonly ?? false;
    this.db = new Database(dbPath, this.readOnly ? { readonly: true } : { create: true });
    this.vectorWeight = clampWeight(process.env.GOBLIN_MEMORY_VECTOR_WEIGHT, 0.7);
    this.textWeight = clampWeight(process.env.GOBLIN_MEMORY_TEXT_WEIGHT, 0.3);
    if (this.vectorWeight + this.textWeight === 0) {
      this.vectorWeight = 0.7;
      this.textWeight = 0.3;
    }

    if (this.readOnly) {
      // Readonly mode: verify the schema is present but do not run DDL or
      // migrations. The database must already be initialized.
      try {
        const current = this.readSchemaVersion();
        if (current > MEMORY_SCHEMA_VERSION) {
          throw new Error(
            `memory schema version ${current} is newer than supported ${MEMORY_SCHEMA_VERSION}`,
          );
        }
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }

    try {
      // Read and reject a future schema before current DDL can mutate it.
      const current = this.readSchemaVersion();
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 2000;");
      this.db.exec(DDL);
      this.migrate(current);
      this.db.exec(INDEX_DDL);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private readSchemaVersion(): number {
    const hasMetaTable = this.db
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_meta'",
      )
      .get();
    if (!hasMetaTable) return 0;

    const row = this.db
      .query<{ value: string | null }, { $key: string }>(
        "SELECT value FROM memory_meta WHERE key = $key",
      )
      .get({ $key: "schema_version" });
    if (!row) return 0;
    if (row.value === null || !/^(0|[1-9]\d*)$/.test(row.value)) {
      throw new Error(`invalid memory schema version: ${String(row.value)}`);
    }

    const current = Number(row.value);
    if (!Number.isSafeInteger(current)) {
      throw new Error(`invalid memory schema version: ${row.value}`);
    }
    if (current > MEMORY_SCHEMA_VERSION) {
      throw new Error(
        `memory schema version ${current} is newer than supported ${MEMORY_SCHEMA_VERSION}`,
      );
    }
    return current;
  }

  private migrate(current: number): void {
    // Schema migration: add display_order to existing databases.
    const hasDisplayOrder = this.db
      .query<{ name: string }, []>("PRAGMA table_info(memory_entries)")
      .all()
      .some((col) => col.name === "display_order");
    if (!hasDisplayOrder) {
      this.db.exec("ALTER TABLE memory_entries ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        UPDATE memory_entries
        SET display_order = (
          SELECT COUNT(*)
          FROM memory_entries e2
          WHERE e2.scope = memory_entries.scope
            AND e2.entry_kind = memory_entries.entry_kind
            AND (
              e2.created_at < memory_entries.created_at
              OR (e2.created_at = memory_entries.created_at AND e2.id < memory_entries.id)
            )
        )
      `);
      log.info("memory database migrated", { addedColumn: "display_order" });
    }

    const hasSourceSurfaceId = this.db
      .query<{ name: string }, []>("PRAGMA table_info(memory_entries)")
      .all()
      .some((col) => col.name === "source_surface_id");
    if (!hasSourceSurfaceId) {
      this.db.exec("ALTER TABLE memory_entries ADD COLUMN source_surface_id TEXT");
      log.info("memory database migrated", { addedColumn: "source_surface_id" });
    }

    if (!Number.isFinite(current) || current < MEMORY_SCHEMA_VERSION) {
      this.db
        .query(
          `INSERT OR REPLACE INTO memory_meta (key, value, updated_at) VALUES ($key, $value, $updated_at)`,
        )
        .run({
          $key: "schema_version",
          $value: String(MEMORY_SCHEMA_VERSION),
          $updated_at: Date.now(),
        });
      log.info("memory database initialized", { schemaVersion: MEMORY_SCHEMA_VERSION });
    }
    const reindexing = this.db
      .query<{ value: string }, { $key: string }>("SELECT value FROM memory_meta WHERE key = $key")
      .get({ $key: "reindexing" });
    if (reindexing?.value === "true") {
      this.setMeta("reindexing", "false");
      log.warn("memory reindexing flag was stale; reset to false");
    }

    // Ensure required memory_meta keys exist even before the first embedding
    // is computed. This makes the database self-describing and lets search
    // pick a dimension-compatible query model from the first call.
    if (this.getMeta("embedding_provider") === undefined) {
      this.setMeta("embedding_provider", DEFAULT_EMBEDDING_PROVIDER);
    }
    if (this.getMeta("embedding_model") === undefined) {
      this.setMeta("embedding_model", process.env.GOBLIN_MEMORY_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL);
    }
  }

  get database(): Database {
    return this.db;
  }

  /** Run a parameterless SELECT and return the first row, or null. */
  selectOne<T>(sql: string): T | null {
    return this.db.query<T, []>(sql).get() ?? null;
  }

  get weights(): { vectorWeight: number; textWeight: number } {
    return { vectorWeight: this.vectorWeight, textWeight: this.textWeight };
  }

  setMeta(key: string, value: string): void {
    if (this.readOnly) throw new Error("cannot setMeta on a readonly MemoryDatabase");
    this.db
      .query(
        `INSERT OR REPLACE INTO memory_meta (key, value, updated_at) VALUES ($key, $value, $updated_at)`,
      )
      .run({ $key: key, $value: value, $updated_at: Date.now() });
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .query<{ value: string }, { $key: string }>("SELECT value FROM memory_meta WHERE key = $key")
      .get({ $key: key });
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Side-effect-free, WAL-aware read-only view of the memory database for
 * diagnostics.
 *
 * `-wal`/`-shm` sidecar files mean an active writer has uncheckpointed data.
 * `?mode=ro` is then safe (it follows the existing WAL) and sees the latest
 * writes. If no sidecars are present, the data is already in the main file,
 * and `?immutable=1` prevents this snapshot from creating sidecars.
 */
export class MemorySnapshot {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const hasWal = existsSync(`${dbPath}-wal`);
    const uri = `${pathToFileURL(dbPath).href}${hasWal ? "?mode=ro" : "?immutable=1"}`;
    this.db = new DatabaseSync(uri, { readOnly: true });
  }

  /** Run a parameterless SELECT and return the first row, or null. */
  selectOne<T>(sql: string): T | null {
    const row: unknown = this.db.prepare(sql).get();
    return (row as T | undefined) ?? null;
  }

  getMeta(key: string): string | undefined {
    const row: unknown = this.db
      .prepare("SELECT value FROM memory_meta WHERE key = ?")
      .get(key);
    return (row as { value: string } | undefined)?.value;
  }

  close(): void {
    this.db.close();
  }
}
