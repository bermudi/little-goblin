import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate.ts";
import { readStateVersion, CURRENT_STATE_VERSION, stateVersionPath } from "./state-version.ts";
import { configPath, topicSettingsPath } from "./sessions/paths.ts";
import { dmSurface, surfaceId } from "./surface.ts";

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
    expect(existsSync(join(home, backups[0] as string, "state", "pre-existing.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(home, backups[0] as string, "snapshot.json"), "utf-8"));
    expect(manifest.roots.some((r: { path: string; exists: boolean }) => r.path === "state" && r.exists)).toBe(true);
  });

  it("records absence of optional roots before setup creates them", () => {
    rmSync(join(home, "state"), { recursive: true, force: true });
    runMigrations(home);
    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    const manifest = JSON.parse(readFileSync(join(home, backups[0] as string, "snapshot.json"), "utf-8"));
    expect(manifest.roots.some((r: { path: string; exists: boolean }) => r.path === "state" && !r.exists)).toBe(true);
    expect(existsSync(join(home, backups[0] as string, "state"))).toBe(false);
  });

  it("is idempotent", () => {
    runMigrations(home);
    runMigrations(home);
    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    expect(backups.length).toBe(1);
  });

  it("refuses to run when state version is newer than supported", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: CURRENT_STATE_VERSION + 10 }));
    expect(() => runMigrations(home)).toThrow(/newer than supported/);
  });

  it("refuses to run when state version file is malformed", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(stateVersionPath(home), "not json");
    expect(() => runMigrations(home)).toThrow(/malformed state version file/);
  });

  it("fails preflight on a later step without mutating step-1 inputs", () => {
    // Surface step 1 would succeed, but environment step 2 fails because the
    // session's pi history is incompatible with the inferred personal env.
    const sessionId = "abcd1234ef";
    writeFileSync(configPath(home), JSON.stringify({
      version: 1,
      surfaces: { [surfaceId(dmSurface(1))]: sessionId },
    }));
    writeFileSync(topicSettingsPath(home), JSON.stringify({ version: 1, surfaces: {} }));
    const sessionDir = join(home, "state", "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(sessionDir, "pi"), { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
      id: sessionId,
      chatId: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
    }));
    writeFileSync(join(sessionDir, "pi", "history.jsonl"), JSON.stringify({ cwd: "/some/other/path" }) + "\n{}", "utf-8");

    expect(() => runMigrations(home)).toThrow(/incompatible pi history/);

    // Step 1 should not have written its outputs because planning failed.
    expect(readFileSync(configPath(home), "utf-8")).toContain("version");
    expect(readStateVersion(home)).toBe(0);
  });

  it("advances from version 4 to 5 and creates the delegated-work runs root", () => {
    // Plant a version-4 home so only step 5 runs.
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 4 }));
    runMigrations(home);
    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    expect(existsSync(join(home, "state", "delegated-work", "runs"))).toBe(true);
  });

  it("is a no-op when already at the current version", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: CURRENT_STATE_VERSION }));
    runMigrations(home);
    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    expect(backups.length).toBe(0);
  });

  it("deployment order: the state-version gate refuses to poll until migrate runs", () => {
    // A pre-break home sits at version 4. The startup gate in src/index.ts
    // checks readStateVersion(home) !== CURRENT_STATE_VERSION and exits.
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 4 }));
    expect(readStateVersion(home)).not.toBe(CURRENT_STATE_VERSION);

    // After migration, the gate passes.
    runMigrations(home);
    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
  });
});
