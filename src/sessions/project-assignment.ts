/**
 * Pending project-assignment intent storage and helpers.
 *
 * A pending intent captures the durable commit point for first project
 * assignment: SurfaceId, optional prior Conversation ID, planned future
 * Conversation ID, and canonical project root. It is persisted atomically
 * before the Conversation directory or binding is mutated, and cleared once
 * the assignment is complete.
 */

import type { Surface, SurfaceId } from "../surface.ts";
import type { SessionState } from "./types.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { pendingProjectAssignmentPath } from "./paths.ts";

export interface ProjectAssignmentIntent {
  version: 1;
  surfaceId: SurfaceId;
  previousSessionId?: string;
  plannedSessionId: string;
  projectRoot: string;
}

function isPendingIntent(value: unknown): value is ProjectAssignmentIntent {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.surfaceId === "string" &&
    typeof v.plannedSessionId === "string" &&
    typeof v.projectRoot === "string" &&
    (v.previousSessionId === undefined || typeof v.previousSessionId === "string")
  );
}

export function loadPendingProjectAssignment(home: string): ProjectAssignmentIntent | null {
  const raw = loadJsonFile<ProjectAssignmentIntent | null>(pendingProjectAssignmentPath(home), null);
  if (raw === null) return null;
  if (!isPendingIntent(raw)) {
    log.warn("malformed pending project assignment file, treating as absent", { path: pendingProjectAssignmentPath(home) });
    return null;
  }
  return raw;
}

export function savePendingProjectAssignment(home: string, intent: ProjectAssignmentIntent): void {
  saveJsonFile(pendingProjectAssignmentPath(home), intent);
  log.info("pending project assignment persisted", { surfaceId: intent.surfaceId, plannedSessionId: intent.plannedSessionId });
}

export function clearPendingProjectAssignment(home: string): void {
  const path = pendingProjectAssignmentPath(home);
  try {
    const intent = loadPendingProjectAssignment(home);
    if (intent === null) return;
    saveJsonFile(path, null);
    log.info("pending project assignment cleared", { surfaceId: intent.surfaceId });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export function buildProjectSessionState(
  id: string,
  surface: Surface,
  projectRoot: string,
  now = new Date().toISOString(),
): SessionState {
  return {
    id,
    createdAt: now,
    chatId: surface.chatId,
    topicId: surface.kind === "topic" ? surface.topicId : undefined,
    executionEnvironment: { kind: "project", projectRoot },
  };
}
