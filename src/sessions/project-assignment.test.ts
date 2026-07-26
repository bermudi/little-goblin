import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId, topicSurface } from "../surface.ts";
import type { SurfaceId } from "../surface.ts";
import {
  buildProjectSessionState,
  clearPendingProjectAssignment,
  loadPendingProjectAssignment,
  pendingProjectAssignmentPath,
  savePendingProjectAssignment,
} from "./project-assignment.ts";

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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-pa-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadPendingProjectAssignment", () => {
    it("returns null when the file is missing", () => {
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
    });

    it("returns the intent when present", () => {
      const intent = makeIntent(surfaceId(dmSurface(1)), "/srv/project");
      savePendingProjectAssignment(tmpDir, intent);
      expect(loadPendingProjectAssignment(tmpDir)).toEqual(intent);
    });

    it("returns null for a malformed file", () => {
      const path = pendingProjectAssignmentPath(tmpDir);
      const parent = join(path, "..");
      // eslint-disable-next-line no-restricted-globals
      mkdirSync(parent, { recursive: true });
      writeFileSync(path, "{ not valid");
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
    });
  });

  describe("clearPendingProjectAssignment", () => {
    it("clears a persisted intent", () => {
      const intent = makeIntent(surfaceId(dmSurface(1)), "/srv/project");
      savePendingProjectAssignment(tmpDir, intent);
      clearPendingProjectAssignment(tmpDir);
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
      expect(existsSync(pendingProjectAssignmentPath(tmpDir))).toBe(true);
    });

    it("is a no-op when no intent exists", () => {
      clearPendingProjectAssignment(tmpDir);
      expect(loadPendingProjectAssignment(tmpDir)).toBeNull();
    });
  });

  describe("buildProjectSessionState", () => {
    it("builds a DM project session state", () => {
      const surface = dmSurface(42);
      const state = buildProjectSessionState("abc123def0", surface, "/srv/project", "2024-01-01T00:00:00.000Z");
      expect(state.id).toBe("abc123def0");
      expect(state.chatId).toBe(42);
      expect(state.topicId).toBeUndefined();
      expect(state.executionEnvironment).toEqual({ kind: "project", projectRoot: "/srv/project" });
      expect(state.createdAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("builds a topic project session state", () => {
      const surface = topicSurface("supergroup", -100, 7);
      const state = buildProjectSessionState("abc123def0", surface, "/srv/project");
      expect(state.chatId).toBe(-100);
      expect(state.topicId).toBe(7);
      expect(state.executionEnvironment).toEqual({ kind: "project", projectRoot: "/srv/project" });
    });
  });
});
