import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId } from "../surface.ts";
import type { SurfaceId } from "../surface.ts";
import {
  clearPendingProjectAssignment,
  loadPendingProjectAssignment,
  savePendingProjectAssignment,
} from "./project-assignment.ts";
import { pendingProjectAssignmentPath } from "./paths.ts";

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
});
