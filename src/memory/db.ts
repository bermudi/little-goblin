import { Database } from "bun:sqlite";
import { log } from "../log.ts";
import { DDL, INDEX_DDL, MEMORY_SCHEMA_VERSION } from "./schema.ts";

function clampWeight(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export class MemoryDatabase {
  private db: Database;
  private vectorWeight: number;
  private textWeight: number;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 2000;");
    this.db.exec(DDL);
    this.db.exec(INDEX_DDL);
    this.vectorWeight = clampWeight(process.env.GOBLIN_MEMORY_VECTOR_WEIGHT, 0.7);
    this.textWeight = clampWeight(process.env.GOBLIN_MEMORY_TEXT_WEIGHT, 0.3);
    if (this.vectorWeight + this.textWeight === 0) {
      this.vectorWeight = 0.7;
      this.textWeight = 0.3;
    }
    this.migrate();
  }

  private migrate(): void {
    const row = this.db
      .query<{ value: string }, { $key: string }>("SELECT value FROM memory_meta WHERE key = $key")
      .get({ $key: "schema_version" });
    const current = row ? Number.parseInt(row.value, 10) : 0;
    if (!Number.isFinite(current) || current < MEMORY_SCHEMA_VERSION) {
      if (current < 2) {
        this.migrateToDisplayOrder();
      }
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
  }

  private migrateToDisplayOrder(): void {
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(memory_entries)")
      .all();
    if (!columns.some((c) => c.name === "display_order")) {
      this.db.exec("ALTER TABLE memory_entries ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0");
    }
    this.db
      .query("UPDATE memory_entries SET display_order = created_at WHERE display_order = 0")
      .run();
  }

  get database(): Database {
    return this.db;
  }

  get weights(): { vectorWeight: number; textWeight: number } {
    return { vectorWeight: this.vectorWeight, textWeight: this.textWeight };
  }

  setMeta(key: string, value: string): void {
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
