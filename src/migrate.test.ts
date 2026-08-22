import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { cpSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
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

  it("keeps the last completed checkpoint and a usable backup when apply is interrupted", () => {
    const conversationId = "c3d4e5f6a7";
    const sessionDir = join(home, "state", "sessions", conversationId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
      id: conversationId,
      createdAt: "2026-07-27T10:00:00.000Z",
      chatId: 1,
      title: "At version 3",
      executionEnvironment: { kind: "personal" },
    }) + "\n");
    writeFileSync(join(home, "state", "bindings.json"), JSON.stringify({
      version: 1,
      surfaces: { "tg:v1:dm:1": conversationId },
    }) + "\n");
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 3 }) + "\n");

    const runsRoot = join(home, "state", "delegated-work", "runs");
    const originalMkdirSync = fs.mkdirSync;
    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(((path, options) => {
      const result = originalMkdirSync(path, options);
      if (String(path) === runsRoot) {
        throw new Error("simulated interruption after step-5 apply mutation");
      }
      return result;
    }) as typeof fs.mkdirSync);

    try {
      expect(() => runMigrations(home)).toThrow(/simulated interruption/);
    } finally {
      mkdirSpy.mockRestore();
    }

    // Step 4 completed and checkpointed. Step 5 mutated its layout but did not
    // checkpoint. Decision 0038 requires restoring the command's backup rather
    // than treating this partial tree as restart-safe.
    expect(readStateVersion(home)).toBe(4);
    expect(existsSync(runsRoot)).toBe(true);
    const backups = readdirSync(home).filter((name) => name.startsWith(".migration-backup-"));
    expect(backups).toHaveLength(1);
    const backup = join(home, backups[0] as string);
    expect(existsSync(join(backup, "snapshot.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(backup, "state", "state-version.json"), "utf-8"))).toEqual({ version: 3 });

    rmSync(join(home, "state"), { recursive: true });
    cpSync(join(backup, "state"), join(home, "state"), { recursive: true });
    expect(readStateVersion(home)).toBe(3);
    expect(existsSync(runsRoot)).toBe(false);

    runMigrations(home);

    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    expect(existsSync(backup)).toBe(true);
  });

  it("does not replan step 2 against already-canonical Conversation state at version 4", () => {
    // A v4 home has already been through conversation migration: session
    // state is the canonical Conversation shape (no chatId). Step 2's
    // planner reads the legacy session shape and would throw
    // "malformed legacy shape" if the runner still planned applied steps.
    const conversationId = "a1b2c3d4e5";
    const sessionDir = join(home, "state", "sessions", conversationId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
      id: conversationId,
      createdAt: "2026-07-27T10:00:00.000Z",
      title: "Already migrated",
      executionEnvironment: { kind: "personal" },
    }) + "\n");
    writeFileSync(join(home, "state", "bindings.json"), JSON.stringify({
      version: 1,
      surfaces: { "tg:v1:dm:1": conversationId },
    }) + "\n");
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 4 }) + "\n");

    runMigrations(home);

    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    expect(JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8"))).toEqual({
      id: conversationId,
      createdAt: "2026-07-27T10:00:00.000Z",
      title: "Already migrated",
      executionEnvironment: { kind: "personal" },
    });
    expect(existsSync(join(home, "state", "delegated-work", "runs"))).toBe(true);
  });

  it("does not replan earlier steps from intermediate versions 1, 2, or 3", () => {
    // Intermediate homes already have the filesystem shape later planners
    // expect. Replanning applied steps would either fail or rewrite them.
    for (const version of [1, 2, 3] as const) {
      const versionHome = mkdtempSync(join(tmpdir(), `goblin-migrate-v${version}-`));
      try {
        mkdirSync(join(versionHome, "state"), { recursive: true });
        const conversationId = "b2c3d4e5f6";
        const sessionDir = join(versionHome, "state", "sessions", conversationId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
          id: conversationId,
          createdAt: "2026-07-27T10:00:00.000Z",
          chatId: 1,
          title: `At version ${version}`,
          executionEnvironment: { kind: "personal" },
        }) + "\n");
        writeFileSync(join(versionHome, "state", "bindings.json"), JSON.stringify({
          version: 1,
          surfaces: { "tg:v1:dm:1": conversationId },
        }) + "\n");
        writeFileSync(stateVersionPath(versionHome), JSON.stringify({ version }) + "\n");

        runMigrations(versionHome);

        expect(readStateVersion(versionHome)).toBe(CURRENT_STATE_VERSION);
        const after = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as {
          chatId?: unknown;
          executionEnvironment: unknown;
        };
        expect(after.chatId).toBeUndefined();
        expect(after.executionEnvironment).toEqual({ kind: "personal" });
      } finally {
        rmSync(versionHome, { recursive: true, force: true });
      }
    }
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
