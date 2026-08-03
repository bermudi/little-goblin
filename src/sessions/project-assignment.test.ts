import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId } from "../surface.ts";
import type { SurfaceId } from "../surface.ts";
import {
  applyPreparedProjectAssignment,
  clearPendingProjectAssignment,
  loadPendingProjectAssignment,
  preparePendingProjectAssignment,
  savePendingProjectAssignment,
} from "./project-assignment.ts";
import { pendingProjectAssignmentPath, topicSettingsPath } from "./paths.ts";
import { ConversationStore } from "./conversation-store.ts";
import { personalEnvironment, projectEnvironment } from "./environment.ts";
import { loadTopicSettings } from "./topic-settings.ts";
import type { BindingsFile } from "./types.ts";

class InMemoryBindingStore {
  bindings: BindingsFile = { version: 1, surfaces: {} };

  load(): BindingsFile {
    return this.bindings;
  }

  save(b: BindingsFile): void {
    this.bindings = { version: 1, surfaces: { ...b.surfaces } } as BindingsFile;
  }
}

function makeIntent(id: SurfaceId, projectRoot: string, previousSessionId?: string) {
  return {
    version: 1 as const,
    surfaceId: id,
    plannedSessionId: "abc123def0",
    projectRoot,
    ...(previousSessionId !== undefined ? { previousSessionId } : {}),
  };
}

describe("project-assignment", () => {
  let tmpDir: string;
  let store: ConversationStore;
  let bindings: InMemoryBindingStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-pa-test-"));
    store = new ConversationStore(tmpDir);
    bindings = new InMemoryBindingStore();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProjectDir(name: string): string {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  describe("loadPendingProjectAssignment", () => {
    it("returns null when the file is missing", () => {
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
    });

    it("returns the intent when present", () => {
      const intent = makeIntent(surfaceId(dmSurface(1)), makeProjectDir("project"));
      savePendingProjectAssignment(tmpDir, intent);
      expect(loadPendingProjectAssignment(tmpDir)).toEqual(intent);
    });

    it("rejects null rather than treating a present pending file as absent", () => {
      const path = pendingProjectAssignmentPath(tmpDir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "null");
      expect(() => loadPendingProjectAssignment(tmpDir)).toThrow(/invalid pending project assignment/);
    });

    it("rejects a malformed file rather than treating pending authority as absent", () => {
      const path = pendingProjectAssignmentPath(tmpDir);
      const parent = join(path, "..");
      // eslint-disable-next-line no-restricted-globals
      mkdirSync(parent, { recursive: true });
      writeFileSync(path, "{ not valid");
      expect(() => loadPendingProjectAssignment(tmpDir)).toThrow(SyntaxError);
    });
  });

  describe("clearPendingProjectAssignment", () => {
    it("deletes a persisted intent", () => {
      const intent = makeIntent(surfaceId(dmSurface(1)), makeProjectDir("project"));
      savePendingProjectAssignment(tmpDir, intent);
      clearPendingProjectAssignment(tmpDir);
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      expect(existsSync(pendingProjectAssignmentPath(tmpDir))).toBe(false);
    });

    it("rejects invalid present authority rather than deleting it", () => {
      const path = pendingProjectAssignmentPath(tmpDir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "null");

      expect(() => clearPendingProjectAssignment(tmpDir)).toThrow(/invalid pending project assignment/);
      expect(readFileSync(path, "utf-8")).toBe("null");
    });

    it("is a no-op when no intent exists", () => {
      clearPendingProjectAssignment(tmpDir);
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
    });
  });

  describe("prepared assignment", () => {
    function prepareAndApply(): void {
      const prepared = preparePendingProjectAssignment(tmpDir, store, bindings);
      if (prepared === null) throw new Error("expected a pending assignment");
      applyPreparedProjectAssignment(tmpDir, bindings, prepared);
    }

    function makeProjectDir(name: string): string {
      const dir = join(tmpDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    function writeState(id: string, env: unknown): void {
      const dir = join(tmpDir, "state", "sessions", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({ id, createdAt: new Date().toISOString(), executionEnvironment: env }), "utf-8");
      writeFileSync(join(dir, "transcript.jsonl"), "", "utf-8");
      writeFileSync(join(dir, "metrics.jsonl"), "", "utf-8");
      writeFileSync(join(dir, "events.jsonl"), "", "utf-8");
    }

    const surface = dmSurface(1);
    const key = surfaceId(surface);
    const plannedId = "abc123def0";
    let projectRoot: string;

    beforeEach(() => {
      projectRoot = makeProjectDir("project");
    });

    it("creates Q during planning without writing authority, then applies the plan", () => {
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });

      const prepared = preparePendingProjectAssignment(tmpDir, store, bindings);

      expect(prepared?.conversation.id).toBe(plannedId);
      expect(store.load(plannedId)?.executionEnvironment).toEqual(projectEnvironment(projectRoot));
      expect(loadPendingProjectAssignment(tmpDir)?.plannedSessionId).toBe(plannedId);
      expect(bindings.bindings.surfaces[key]).toBeUndefined();
      expect(loadTopicSettings(tmpDir).surfaces[key]).toBeUndefined();

      if (prepared === null) throw new Error("expected a prepared assignment");
      applyPreparedProjectAssignment(tmpDir, bindings, prepared);

      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      expect(bindings.bindings.surfaces[key]).toBe(plannedId);
      expect(loadTopicSettings(tmpDir).surfaces[key]).toEqual({ projectRoot });
    });

    it("reuses Q when a matching Q exists", () => {
      writeState(plannedId, projectEnvironment(projectRoot));
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });

      prepareAndApply();

      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(plannedId);
      expect(bindings.bindings.surfaces[key]).toBe(plannedId);
      expect(loadTopicSettings(tmpDir).surfaces[key]).toEqual({ projectRoot });
    });

    it("binds Q when settings were persisted before binding", () => {
      writeState(plannedId, projectEnvironment(projectRoot));
      mkdirSync(join(tmpDir, "state"), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({ version: 1, surfaces: { [key]: { projectRoot } } }), "utf-8");
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });

      prepareAndApply();

      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      expect(bindings.bindings.surfaces[key]).toBe(plannedId);
    });

    it("binds Q when previous session P was persisted before binding", () => {
      const previousId = "fed321cba0";
      writeState(plannedId, projectEnvironment(projectRoot));
      writeState(previousId, personalEnvironment());
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        previousSessionId: previousId,
        plannedSessionId: plannedId,
        projectRoot,
      });
      bindings.bindings = { version: 1, surfaces: { [key]: previousId } } as BindingsFile;

      prepareAndApply();

      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      expect(bindings.bindings.surfaces[key]).toBe(plannedId);
      expect(store.load(previousId)).not.toBeNull();
    });

    it("clears the intent when binding already points to Q", () => {
      writeState(plannedId, projectEnvironment(projectRoot));
      mkdirSync(join(tmpDir, "state"), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({ version: 1, surfaces: { [key]: { projectRoot } } }), "utf-8");
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });
      bindings.bindings = { version: 1, surfaces: { [key]: plannedId } } as BindingsFile;

      const beforeList = store.list();
      prepareAndApply();

      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      expect(store.list()).toEqual(beforeList);
      expect(bindings.bindings.surfaces[key]).toBe(plannedId);
    });

    it("fails before settings or binding when the future Conversation ID conflicts", () => {
      writeState(plannedId, personalEnvironment());
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });

      expect(() => prepareAndApply()).toThrow(/different execution environment/);
      expect(loadPendingProjectAssignment(tmpDir)).not.toBeNull();
      expect(loadTopicSettings(tmpDir).surfaces[key]).toBeUndefined();
      expect(bindings.bindings.surfaces[key]).toBeUndefined();
    });

    it("rejects a planned Conversation already bound to another Surface before writing settings", () => {
      writeState(plannedId, projectEnvironment(projectRoot));
      const otherKey = surfaceId(dmSurface(2));
      bindings.bindings = { version: 1, surfaces: { [otherKey]: plannedId } } as BindingsFile;
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });

      expect(() => prepareAndApply()).toThrow(/planned conversation.*bound to/);
      expect(loadPendingProjectAssignment(tmpDir)).not.toBeNull();
      expect(loadTopicSettings(tmpDir).surfaces[key]).toBeUndefined();
      expect(bindings.bindings.surfaces[otherKey]).toBe(plannedId);
    });

    it("rejects malformed or chatId:0 planned state without changing other authority", () => {
      const stateDir = join(tmpDir, "state", "sessions", plannedId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), "{ malformed");
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });
      const malformedBefore = readFileSync(join(stateDir, "state.json"), "utf-8");

      expect(() => prepareAndApply()).toThrow(SyntaxError);
      expect(readFileSync(join(stateDir, "state.json"), "utf-8")).toBe(malformedBefore);
      expect(loadTopicSettings(tmpDir).surfaces[key]).toBeUndefined();
      expect(bindings.bindings.surfaces[key]).toBeUndefined();

      rmSync(stateDir, { recursive: true, force: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), JSON.stringify({
        id: plannedId,
        createdAt: new Date().toISOString(),
        chatId: 0,
        executionEnvironment: personalEnvironment(),
      }));

      expect(() => prepareAndApply()).toThrow(/unexpected state field: chatId/);
      expect(loadTopicSettings(tmpDir).surfaces[key]).toBeUndefined();
      expect(bindings.bindings.surfaces[key]).toBeUndefined();
    });

    it("rejects an invalid surface id before persisting the intent", () => {
      expect(() => savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: "not-a-valid-surface-id" as SurfaceId,
        plannedSessionId: plannedId,
        projectRoot,
      })).toThrow(/SurfaceId/);
    });

    it("rejects an invalid binding without overwriting it during replay", () => {
      writeState(plannedId, projectEnvironment(projectRoot));
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: plannedId,
        projectRoot,
      });
      bindings.bindings = { version: 1, surfaces: { [key]: "not-valid" } } as BindingsFile;

      expect(() => prepareAndApply()).toThrow(/invalid conversation id/);
      expect(bindings.bindings.surfaces[key]).toBe("not-valid");
      expect(loadPendingProjectAssignment(tmpDir)).not.toBeNull();
    });
  });
});
