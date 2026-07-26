import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate.ts";
import { readStateVersion, CURRENT_STATE_VERSION } from "./state-version.ts";

describe("runMigrations", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-migrate-"));
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "pre-existing.json"), "{}")
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the current state version on a fresh home", () => {
    runMigrations(home);
    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
  });

  it("creates a backup of state/ before mutating", () => {
    runMigrations(home);
    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    expect(backups.length).toBe(1);
    expect(existsSync(join(home, backups[0] as string, "pre-existing.json"))).toBe(true);
  });

  it("is idempotent", () => {
    runMigrations(home);
    runMigrations(home);
    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    expect(backups.length).toBe(1);
  });
});
