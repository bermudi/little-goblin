import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConversationMigration, planConversationMigration } from "./conversation-migration.ts";
import { heartbeatMdPathForSession, schedulesPath, sessionDir, sessionsDir, statePath, surfaceHeartbeatPath } from "./paths.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { runMigrations } from "../migrate.ts";
import { readStateVersion, stateVersionPath } from "../state-version.ts";
import type { BindingsFile, TopicSettingsFile } from "./types.ts";

const CONVERSATION_ID = "a1b2c3d4e5";
const ARCHIVED_ID = "f6a7b8c9d0";
const SURFACE = dmSurface(123456);
const SURFACE_ID = surfaceId(SURFACE);

function writeState(home: string, id: string, state: unknown, archived = false): void {
  const dir = archived ? join(sessionsDir(home), "archive", id) : sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

function legacyState(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdAt: "2026-07-27T10:00:00.000Z",
    chatId: 123456,
    topicId: 7,
    title: "Legacy conversation",
    executionEnvironment: { kind: "personal" },
    modelName: "legacy-model",
    thinkingLevel: "high",
    projectDir: "/legacy/project",
    ...overrides,
  };
}

function writeBindings(home: string, bindings: BindingsFile): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "bindings.json"), JSON.stringify(bindings, null, 2) + "\n");
}

function writeSettings(home: string, settings: TopicSettingsFile): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "topic-settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

describe("conversation migration", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-conversation-migration-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("canonicalizes conversation records and moves their owned fields", () => {
    const projectRoot = join(home, "canonical-project");
    mkdirSync(projectRoot, { recursive: true });
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID));
    writeState(home, ARCHIVED_ID, legacyState(ARCHIVED_ID), true);
    writeBindings(home, { version: 1, surfaces: { [SURFACE_ID]: CONVERSATION_ID } });
    writeSettings(home, {
      version: 1,
      surfaces: { [SURFACE_ID]: { projectRoot, thinkingLevel: "medium" } },
    });
    writeFileSync(
      schedulesPath(home),
      JSON.stringify({
        schedules: [{
          id: "schedule-1",
          sessionId: CONVERSATION_ID,
          surfaceId: SURFACE_ID,
          kind: "recurring",
          prompt: "Check the build",
          enabled: true,
          state: "enabled",
          nextRunAt: "2026-07-27T11:00:00.000Z",
          intervalMs: 3_600_000,
          createdAt: "2026-07-27T10:00:00.000Z",
          source: "user",
        }],
      }, null, 2) + "\n",
    );
    const legacyPrompt = heartbeatMdPathForSession(home, CONVERSATION_ID);
    mkdirSync(join(legacyPrompt, ".."), { recursive: true });
    writeFileSync(legacyPrompt, "Inspect the deploy status.\n");

    const stateBefore = readFileSync(statePath(home, CONVERSATION_ID), "utf-8");
    const plan = planConversationMigration(home);

    expect(readFileSync(statePath(home, CONVERSATION_ID), "utf-8")).toBe(stateBefore);
    expect(plan.conversationRecords).toHaveLength(2);
    expect(plan.topicSettings?.surfaces[SURFACE_ID]).toEqual({
      projectRoot,
      modelName: "legacy-model",
      thinkingLevel: "medium",
    });
    expect(plan.schedules?.schedules[0]).not.toHaveProperty("sessionId");
    expect(plan.schedules?.schedules[0]).toMatchObject({
      id: "schedule-1",
      surfaceId: SURFACE_ID,
      source: "user",
    });

    applyConversationMigration(home, plan);

    expect(JSON.parse(readFileSync(statePath(home, CONVERSATION_ID), "utf-8"))).toEqual({
      id: CONVERSATION_ID,
      createdAt: "2026-07-27T10:00:00.000Z",
      title: "Legacy conversation",
      executionEnvironment: { kind: "personal" },
    });
    expect(JSON.parse(readFileSync(join(sessionsDir(home), "archive", ARCHIVED_ID, "state.json"), "utf-8"))).toEqual({
      id: ARCHIVED_ID,
      createdAt: "2026-07-27T10:00:00.000Z",
      title: "Legacy conversation",
      executionEnvironment: { kind: "personal" },
    });
    expect(JSON.parse(readFileSync(join(home, "state", "topic-settings.json"), "utf-8"))).toEqual({
      version: 1,
      surfaces: {
        [SURFACE_ID]: {
          projectRoot,
          modelName: "legacy-model",
          thinkingLevel: "medium",
        },
      },
    });
    expect(JSON.parse(readFileSync(schedulesPath(home), "utf-8")).schedules[0]).not.toHaveProperty("sessionId");
    expect(readFileSync(surfaceHeartbeatPath(home, SURFACE_ID), "utf-8")).toBe("Inspect the deploy status.\n");
    expect(existsSync(legacyPrompt)).toBe(false);
  });

  it("runs step 4 once from state version 3", () => {
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID, { projectDir: undefined }));
    writeBindings(home, { version: 1, surfaces: { [SURFACE_ID]: CONVERSATION_ID } });
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 3 }) + "\n");

    runMigrations(home);

    expect(readStateVersion(home)).toBe(4);
    expect(JSON.parse(readFileSync(statePath(home, CONVERSATION_ID), "utf-8"))).toEqual({
      id: CONVERSATION_ID,
      createdAt: "2026-07-27T10:00:00.000Z",
      title: "Legacy conversation",
      executionEnvironment: { kind: "personal" },
    });

    runMigrations(home);
    expect(readStateVersion(home)).toBe(4);
  });

  it("applies the precomputed state rather than re-reading a changed source", () => {
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID));
    const plan = planConversationMigration(home);
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID, { title: "Changed after planning" }));

    applyConversationMigration(home, plan);

    expect(JSON.parse(readFileSync(statePath(home, CONVERSATION_ID), "utf-8"))).toMatchObject({
      title: "Legacy conversation",
    });
  });

  it("keeps unbound legacy preferences out of Surface settings", () => {
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID));

    const plan = planConversationMigration(home);

    expect(plan.topicSettings).toBeNull();
  });

  it("fails malformed conversation state before advancing version 3", () => {
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID, {
      createdAt: "not-a-date",
      projectDir: undefined,
    }));
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 3 }) + "\n");
    const before = readFileSync(statePath(home, CONVERSATION_ID), "utf-8");

    expect(() => runMigrations(home)).toThrow(/missing or invalid createdAt/);
    expect(readStateVersion(home)).toBe(3);
    expect(readFileSync(statePath(home, CONVERSATION_ID), "utf-8")).toBe(before);
  });

  it("propagates non-ENOENT state read failures", () => {
    mkdirSync(statePath(home, CONVERSATION_ID), { recursive: true });

    expect(() => planConversationMigration(home)).toThrow();
  });

  it("rejects malformed schedule records instead of preserving them", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(schedulesPath(home), JSON.stringify({
      schedules: [{
        id: "schedule-1",
        sessionId: CONVERSATION_ID,
        surfaceId: SURFACE_ID,
        kind: "unexpected",
        prompt: "Check the build",
        enabled: true,
        state: "enabled",
        nextRunAt: "2026-07-27T11:00:00.000Z",
        createdAt: "2026-07-27T10:00:00.000Z",
      }],
    }));

    expect(() => planConversationMigration(home)).toThrow(/invalid kind/);
  });

  it("accepts identical heartbeat prompt content and removes the legacy copy", () => {
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID));
    writeBindings(home, { version: 1, surfaces: { [SURFACE_ID]: CONVERSATION_ID } });
    const source = heartbeatMdPathForSession(home, CONVERSATION_ID);
    const destination = surfaceHeartbeatPath(home, SURFACE_ID);
    mkdirSync(join(source, ".."), { recursive: true });
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(source, "same prompt\n");
    writeFileSync(destination, "same prompt\n");

    applyConversationMigration(home, planConversationMigration(home));

    expect(readFileSync(destination, "utf-8")).toBe("same prompt\n");
    expect(existsSync(source)).toBe(false);
  });

  it("refuses multi-bound conversations before writing any lifecycle output", () => {
    const secondSurfaceId = surfaceId(dmSurface(654321));
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID));
    writeBindings(home, {
      version: 1,
      surfaces: {
        [SURFACE_ID]: CONVERSATION_ID,
        [secondSurfaceId]: CONVERSATION_ID,
      },
    });
    const bindingsBefore = readFileSync(join(home, "state", "bindings.json"), "utf-8");
    const stateBefore = readFileSync(statePath(home, CONVERSATION_ID), "utf-8");

    expect(() => planConversationMigration(home)).toThrow(
      new RegExp(`conversation ${CONVERSATION_ID} has multiple surface bindings: .*${SURFACE_ID}.*${secondSurfaceId}`),
    );
    expect(readFileSync(join(home, "state", "bindings.json"), "utf-8")).toBe(bindingsBefore);
    expect(readFileSync(statePath(home, CONVERSATION_ID), "utf-8")).toBe(stateBefore);
  });

  it("refuses duplicate heartbeat records for one surface before writing", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      schedulesPath(home),
      JSON.stringify({
        schedules: [
          {
            id: "heartbeat-1",
            sessionId: CONVERSATION_ID,
            surfaceId: SURFACE_ID,
            kind: "heartbeat",
            prompt: null,
            enabled: true,
            state: "enabled",
            nextRunAt: "2026-07-27T11:00:00.000Z",
            intervalMs: 1_800_000,
            createdAt: "2026-07-27T10:00:00.000Z",
          },
          {
            id: "heartbeat-2",
            sessionId: CONVERSATION_ID,
            surfaceId: SURFACE_ID,
            kind: "heartbeat",
            prompt: null,
            enabled: true,
            state: "enabled",
            nextRunAt: "2026-07-27T11:00:00.000Z",
            intervalMs: 1_800_000,
            createdAt: "2026-07-27T10:00:00.000Z",
          },
        ],
      }),
    );
    const before = readFileSync(schedulesPath(home), "utf-8");

    expect(() => planConversationMigration(home)).toThrow(/duplicate heartbeat schedules/);
    expect(readFileSync(schedulesPath(home), "utf-8")).toBe(before);
  });

  it("refuses differing non-whitespace heartbeat prompts before writing", () => {
    writeState(home, CONVERSATION_ID, legacyState(CONVERSATION_ID));
    writeBindings(home, { version: 1, surfaces: { [SURFACE_ID]: CONVERSATION_ID } });
    const source = heartbeatMdPathForSession(home, CONVERSATION_ID);
    const destination = surfaceHeartbeatPath(home, SURFACE_ID);
    mkdirSync(join(source, ".."), { recursive: true });
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(source, "source prompt\n");
    writeFileSync(destination, "destination prompt\n");

    expect(() => planConversationMigration(home)).toThrow(/heartbeat prompt conflict/);
    expect(readFileSync(source, "utf-8")).toBe("source prompt\n");
    expect(readFileSync(destination, "utf-8")).toBe("destination prompt\n");
  });
});
