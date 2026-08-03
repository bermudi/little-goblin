import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateExecutionEnvironments, type LegacySessionState, type LegacyTopicSettingsValue } from "./environment-migration.ts";
import { configPath, piSessionDir, sessionDir, sessionsDir, topicSettingsPath } from "./paths.ts";
import { workspacePath, workdirPath } from "../workspace/paths.ts";
import { dmSurface, supergroupSurface, surfaceId, topicSurface } from "../surface.ts";
import type { BindingsFile, TopicSettingsFile } from "./types.ts";

/** Migration-only topic-settings file shape carrying legacy fields (e.g. pendingProjectNotice). */
type LegacyTopicSettingsFileInput = { version: 1; surfaces: Record<string, LegacyTopicSettingsValue> };

const SESSION_ID = "abcd1234ef";
const OTHER_ID = "abcd1234f0";

function makeLegacyState(overrides?: Partial<LegacySessionState> & Record<string, unknown>): LegacySessionState {
  return {
    id: SESSION_ID,
    createdAt: "2024-01-01T00:00:00.000Z",
    chatId: 1,
    ...overrides,
  } as LegacySessionState;
}

function writeRawState(home: string, id: string, state: unknown): void {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf-8");
}

function writeState(home: string, id: string, state: LegacySessionState): void {
  writeRawState(home, id, state);
}

function writeArchivedState(home: string, id: string, state: LegacySessionState): void {
  const dir = join(sessionsDir(home), "archive", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf-8");
}

function writeBindings(home: string, bindings: BindingsFile): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(bindings), "utf-8");
}

function writeTopicSettings(home: string, settings: TopicSettingsFile | LegacyTopicSettingsFileInput): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(topicSettingsPath(home), JSON.stringify(settings), "utf-8");
}

function writePiHistory(home: string, id: string, cwd: string, archived = false): void {
  const dir = archived ? join(sessionsDir(home), "archive", id, "pi") : piSessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), JSON.stringify({ cwd }) + "\n{}", "utf-8");
}

function writePiHistoryWithBody(home: string, id: string, cwd: string, body: string): void {
  const dir = piSessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), JSON.stringify({ cwd }) + "\n" + body, "utf-8");
}

function readState(home: string, id: string, archived = false): LegacySessionState {
  const dir = archived ? join(sessionsDir(home), "archive", id) : sessionDir(home, id);
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as LegacySessionState;
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
    expect(existsSync(join(tmpDir, "state", "workdir-promotion-manifest.json"))).toBe(false);
  });

  it("throws on workspace collision during workdir promotion", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const workdir = workdirPath(tmpDir);
    const workspace = workspacePath(tmpDir);
    mkdirSync(workdir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workdir, "dup.md"), "src");
    writeFileSync(join(workspace, "dup.md"), "dst");

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/collision/);
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

  it("preserves modelName and thinkingLevel while removing projectDir and notice", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: {
        [surfaceId(dmSurface(1))]: {
          projectDir,
          modelName: "custom-model",
          thinkingLevel: "high",
          pendingProjectNotice: "old notice",
        },
      },
    });

    migrateExecutionEnvironments(tmpDir);

    const settings = JSON.parse(readFileSync(topicSettingsPath(tmpDir), "utf-8")) as TopicSettingsFile;
    const surface = settings.surfaces[surfaceId(dmSurface(1))]!;
    expect(surface.projectRoot).toBe(projectDir);
    expect(surface.projectDir).toBeUndefined();
    expect((surface as LegacyTopicSettingsValue).pendingProjectNotice).toBeUndefined();
    expect(surface.modelName).toBe("custom-model");
    expect(surface.thinkingLevel).toBe("high");
  });

  it("throws when topic settings projectRoot and projectDir disagree", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectA = join(tmpDir, "project-a");
    const projectB = join(tmpDir, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: { [surfaceId(dmSurface(1))]: { projectRoot: projectA, projectDir: projectB } },
    });

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/disagreeing/);
  });

  it("throws when a surface setting project path does not exist", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: { [surfaceId(dmSurface(1))]: { projectDir: "/does/not/exist" } },
    });
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/does not exist/);
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

  it("infers a project environment for an unbound session from a matching surface setting", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeTopicSettings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: { projectRoot: projectDir } } });
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

  it("throws when an unbound session matches surface settings with conflicting project roots", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectA = join(tmpDir, "project-a");
    const projectB = join(tmpDir, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: {
        [surfaceId(dmSurface(1))]: { projectRoot: projectA },
        [surfaceId(supergroupSurface(1))]: { projectRoot: projectB },
      },
    });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/conflicting environments/);
  });

  it("throws when a bound session's legacy projectDir disagrees with its surface", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectA = join(tmpDir, "project-a");
    const projectB = join(tmpDir, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: { [surfaceId(dmSurface(1))]: { projectRoot: projectA } },
    });
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dmSurface(1))]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ projectDir: projectB }));

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/conflicting environments/);
  });

  it("throws when canonical executionEnvironment disagrees with inferred", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ executionEnvironment: { kind: "project", projectRoot: projectDir } }));

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/disagrees with inferred/);
  });

  it("throws when an internal session carries project evidence", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ chatId: 0, projectDir }));

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/internal session .* has projectDir/);
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

  it("preserves non-header pi history lines byte-for-byte", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());
    writePiHistoryWithBody(tmpDir, SESSION_ID, workdirPath(tmpDir), "line2\nline3\n");

    migrateExecutionEnvironments(tmpDir);

    const text = readPiHistory(tmpDir, SESSION_ID);
    const lines = text.split("\n");
    expect(lines[0]).toBe(JSON.stringify({ cwd: workspacePath(tmpDir) }));
    expect(lines[1]).toBe("line2");
    expect(lines[2]).toBe("line3");
  });

  it("migrates archived sessions", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeArchivedState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID, true);
    expect(state.executionEnvironment).toEqual({ kind: "personal" });
  });

  it("rejects a conversation bound to more than one surface before environment inference", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const dm = dmSurface(1);
    const topic = topicSurface("supergroup", 2, 7);
    writeBindings(tmpDir, { version: 1, surfaces: { [surfaceId(dm)]: SESSION_ID, [surfaceId(topic)]: SESSION_ID } });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/already bound/);
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

  it("is idempotent", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    migrateExecutionEnvironments(tmpDir);
    const first = readState(tmpDir, SESSION_ID);
    migrateExecutionEnvironments(tmpDir);
    const second = readState(tmpDir, SESSION_ID);

    expect(second).toEqual(first);
  });

  it("matches topic surfaces by chatId and topicId", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: {
        [surfaceId(dmSurface(1))]: {},
        [surfaceId(topicSurface("supergroup", 1, 5))]: { projectRoot: projectDir },
      },
    });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ chatId: 1, topicId: 5 }));

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID);
    expect(state.executionEnvironment).toEqual({ kind: "project", projectRoot: projectDir });
  });

  it("throws when a topicId-bearing session has no matching topic surface setting", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeTopicSettings(tmpDir, {
      version: 1,
      surfaces: { [surfaceId(dmSurface(1))]: {} },
    });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ chatId: 1, topicId: 5 }));

    migrateExecutionEnvironments(tmpDir);

    const state = readState(tmpDir, SESSION_ID);
    expect(state.executionEnvironment).toEqual({ kind: "personal" });
  });

  it("throws when a session id in state.json disagrees with its directory name", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeState(tmpDir, SESSION_ID, makeLegacyState({ id: "mismatched0000" }));

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/state file id mismatch/);
  });

  it("rejects malformed legacy state at the JSON boundary", () => {
    const malformedStates: unknown[] = [
      null,
      { ...makeLegacyState(), executionEnvironment: null },
      { ...makeLegacyState(), unexpectedAuthority: true },
    ];

    for (const malformed of malformedStates) {
      writeRawState(tmpDir, SESSION_ID, malformed);
      expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/malformed legacy shape/);
    }

    writeRawState(tmpDir, SESSION_ID, { ...makeLegacyState(), createdAt: "not-a-date" });
    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/missing or invalid createdAt/);
  });

  it("rejects an invalid SurfaceId at the bindings load boundary", () => {
    mkdirSync(sessionsDir(tmpDir), { recursive: true });
    writeBindings(tmpDir, {
      version: 1,
      surfaces: { "not-a-surface-id": SESSION_ID } as unknown as BindingsFile["surfaces"],
    });
    writeState(tmpDir, SESSION_ID, makeLegacyState());

    expect(() => migrateExecutionEnvironments(tmpDir)).toThrow(/SurfaceId/);
  });
});
