import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateExecutionEnvironments } from "./environment-migration.ts";
import { configPath, piSessionDir, sessionDir, sessionsDir, topicSettingsPath } from "./paths.ts";
import { workspacePath, workdirPath } from "../workspace/paths.ts";
import { dmSurface, surfaceId, topicSurface } from "../surface.ts";
import type { BindingsFile, SessionState, TopicSettingsFile } from "./types.ts";

const SESSION_ID = "abcd1234ef";
const OTHER_ID = "abcd1234f0";

function makeLegacyState(overrides?: Partial<SessionState> & Record<string, unknown>): SessionState {
  return {
    id: SESSION_ID,
    createdAt: "2024-01-01T00:00:00.000Z",
    chatId: 1,
    ...overrides,
  } as SessionState;
}

function writeState(home: string, id: string, state: SessionState): void {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf-8");
}

function writeArchivedState(home: string, id: string, state: SessionState): void {
  const dir = join(sessionsDir(home), "archive", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf-8");
}

function writeBindings(home: string, bindings: BindingsFile): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(bindings), "utf-8");
}

function writeTopicSettings(home: string, settings: TopicSettingsFile): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(topicSettingsPath(home), JSON.stringify(settings), "utf-8");
}

function writePiHistory(home: string, id: string, cwd: string, archived = false): void {
  const dir = archived ? join(sessionsDir(home), "archive", id, "pi") : piSessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), JSON.stringify({ cwd }) + "\n{}", "utf-8");
}

function readState(home: string, id: string, archived = false): SessionState {
  const dir = archived ? join(sessionsDir(home), "archive", id) : sessionDir(home, id);
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as SessionState;
}

function readPiHistory(home: string, id: string, archived = false): string {
  const dir = archived ? join(sessionsDir(home), "archive", id, "pi") : piSessionDir(home, id);
  return readFileSync(join(dir, "history.jsonl"), "utf-8");
}

describe("environment-migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-mig-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op when there are no sessions", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    migrateExecutionEnvironments(tmpDir);
    expect(existsSync(join(sessionsDir(tmpDir), "..", "topic-settings.json"))).toBe(false);
  });

  it("promotes personal workdir contents to workspace and removes workdir", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const workdir = workdirPath(tmpDir);
    const workspace = workspacePath(tmpDir);
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, "notes.md"), "hello");

    migrateExecutionEnvironments(tmpDir);

    expect(existsSync(join(workspace, "notes.md"))).toBe(true);
    expect(existsSync(workdir)).toBe(false);
  });

  it("canonicalizes topic settings projectDir to projectRoot", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeTopicSettings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: { projectDir } } });

    migrateExecutionEnvironments(tmpDir);

    const settings = JSON.parse(readFileSync(topicSettingsPath(tmpDir), "utf-8")) as TopicSettingsFile;
    expect(settings.surfaces[surfaceId(dmSurface(1))]?.projectRoot).toBe(projectDir);
    expect(settings.surfaces[surfaceId(dmSurface(1))]?.projectDir).toBeUndefined();
  });

  it("infers a personal environment for an unbound session with no projectDir", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID);
    expect(state.executionEnvironment).toEqual({ kind: "personal" });
  });

  it("infers a project environment for a bound session with a projectRoot", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeTopicSettings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: { projectRoot: projectDir } } });
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID);
    expect(state.executionEnvironment).toEqual({ kind: "project", projectRoot: projectDir });
  });

  it("uses the legacy state projectDir for an unbound session", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "legacy-project");
    mkdirSync(projectDir, { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ projectDir }));

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID);
    expect(state.executionEnvironment).toEqual({ kind: "project", projectRoot: projectDir });
  });

  it("normalizes a personal pi history header from scratch/workdir to workspace", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());
    writePiHistory(tmpDir, SESSION_ID, workdirPath(tmpDir));

    migrateExecutionEnvironments(tmpDir);

    const text = readPiHistory(tmpDir, SESSION_ID);
    const firstLine = text.split("\n")[0]!;
    expect(JSON.parse(firstLine).cwd).toBe(workspacePath(tmpDir));
  });

  it("normalizes a project pi history header that is a symlink to the project root", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const linkDir = join(tmpDir, "project-link");
    symlinkSync(projectDir, linkDir);
    writeTopicSettings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: { projectRoot: projectDir } } });
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState());
    writePiHistory(tmpDir, SESSION_ID, linkDir);

    migrateExecutionEnvironments(tmpDir);

    const text = readPiHistory(tmpDir, SESSION_ID);
    const firstLine = text.split("\n")[0]!;
    expect(JSON.parse(firstLine).cwd).toBe(projectDir);
  });

  it("migrates archived sessions", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeArchivedState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID, true);
    expect(state.executionEnvironment).toEqual({ kind: "personal" });
  });

  it("throws when a session is bound to both a project surface and a personal surface", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const dm = dmSurface(1);
    const topic = topicSurface("supergroup", 2, 7);
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: {
        [surfaceId(dm)]: { projectRoot: projectDir },
        [surfaceId(topic)]: {},
      },
    });
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dm)]: SESSION_ID, [surfaceId(topic)]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/conflicting environments/);
  });

  it("throws when a session has an incompatible pi history header", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());
    writePiHistory(tmpDir, SESSION_ID, "/some/other/path");

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/incompatible pi history/);
  });

  it("does not write state when validation fails", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());
    writePiHistory(tmpDir, SESSION_ID, "/some/other/path");
    writeState(tmpDir, OTHER_ID, makeLegacyState({ id: OTHER_ID }));

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/incompatible pi history/);

    expect(readState(tmpDir, OTHER_ID).executionEnvironment).toBeUndefined();
  });

  it("removes topic settings whose project path no longer exists and infers personal", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeTopicSettings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: { projectDir: "/does/not/exist" } } });
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);

    const settings = JSON.parse(readFileSync(topicSettingsPath(tmpDir), "utf-8")) as TopicSettingsFile;
    expect(settings.surfaces[surfaceId(dmSurface(1))]).toBeUndefined();
    const state = readState(tmpDir, SESSION_ID);
    expect(state.executionEnvironment).toEqual({ kind: "personal" });
  });

  it("is idempotent", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);
    const first = readState(tmpDir, SESSION_ID);
    migrateExecutionEnvironments(tmpDir);
    const second = readState(tmpDir, SESSION_ID);

    expect(second).toEqual(first);
  });
});
