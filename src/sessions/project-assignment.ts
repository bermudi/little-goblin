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
import { surfaceId, parseSurfaceId } from "../surface.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { pendingProjectAssignmentPath } from "./paths.ts";
import { ConversationStore } from "./conversation-store.ts";
import type { ConversationId } from "./types.ts";
import { isValidConversationId, validateConversationId } from "./conversation.ts";
import { environmentsEqual, projectEnvironment } from "./environment.ts";
import { getProjectRoot, bindProjectRoot } from "./topic-settings.ts";
import type { BindingStore } from "./bindings.ts";

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
  if (v.version !== 1) return false;
  if (typeof v.surfaceId !== "string") return false;
  if (typeof v.plannedSessionId !== "string" || !isValidConversationId(v.plannedSessionId)) return false;
  if (typeof v.projectRoot !== "string") return false;
  if (v.previousSessionId !== undefined && typeof v.previousSessionId !== "string") return false;
  return true;
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

/**
 * Create a project conversation with the planned id, or verify that an
 * existing conversation at that id already has the expected project
 * environment. Used both during first assignment and crash recovery.
 */
export function createOrVerifyProjectSession(
  store: ConversationStore,
  _surface: Surface,
  id: string,
  projectRoot: string,
): ReturnType<ConversationStore["createWithId"]> {
  validateConversationId(id);
  const existing = store.load(id as ConversationId);
  if (existing) {
    if (!environmentsEqual(existing.executionEnvironment, projectEnvironment(projectRoot))) {
      throw new Error(`pending assignment session ${id} exists with a different execution environment`);
    }
    return existing;
  }
  return store.createWithId(projectEnvironment(projectRoot), id as ConversationId);
}

/**
 * Replay a pending project-assignment intent, if one exists. This is the
 * durable commit point for first project assignment: it creates/verifies the
 * planned conversation, binds the project root to the surface, updates
 * bindings, and clears the intent.
 */
export function reconcilePendingProjectAssignment(
  home: string,
  store: ConversationStore,
  bindingStore: BindingStore,
): void {
  const intent = loadPendingProjectAssignment(home);
  if (intent === null) return;

  let surface: Surface;
  try {
    surface = parseSurfaceId(intent.surfaceId);
  } catch (err) {
    log.error("pending assignment has invalid surface id", { surfaceId: intent.surfaceId });
    throw new Error(`pending assignment has invalid surface id: ${intent.surfaceId}`);
  }

  const key = surfaceId(surface);
  const bindings = bindingStore.load();
  const boundId = bindings.surfaces[key];

  // If the surface is already bound to a conversation with the same project
  // environment, the assignment already happened through another path (e.g. a
  // partial /project that was later auto-corrected by resolveOrStart). Accept
  // the existing binding and clear the stale intent.
  const boundIdValid = boundId !== undefined && isValidConversationId(boundId);
  if (boundIdValid && boundId !== intent.plannedSessionId && boundId !== intent.previousSessionId) {
    const boundConv = store.load(boundId as ConversationId);
    if (boundConv && environmentsEqual(boundConv.executionEnvironment, projectEnvironment(intent.projectRoot))) {
      const settingsRoot = getProjectRoot(home, surface);
      if (settingsRoot !== intent.projectRoot) {
        bindProjectRoot(home, surface, intent.projectRoot);
      }
      clearPendingProjectAssignment(home);
      log.info("pending assignment already satisfied by existing binding", { surfaceId: intent.surfaceId, sessionId: boundId });
      return;
    }
  }

  const conv = createOrVerifyProjectSession(store, surface, intent.plannedSessionId, intent.projectRoot);

  const settingsRoot = getProjectRoot(home, surface);
  if (settingsRoot !== intent.projectRoot) {
    bindProjectRoot(home, surface, intent.projectRoot);
  }

  if (boundId !== conv.id) {
    if (boundIdValid && boundId !== intent.previousSessionId) {
      // The surface is bound to a different conversation and the environment
      // does not match the pending intent; fail loud so the operator can repair.
      throw new Error(
        `pending assignment replay conflict: surface ${intent.surfaceId} is bound to ${boundId}, expected ${intent.previousSessionId ?? "(none)"} or ${conv.id}`,
      );
    }
    if (!boundIdValid && boundId !== undefined) {
      log.warn("pending assignment replay found invalid binding; overwriting", { surfaceId: intent.surfaceId, boundId });
    }
    bindings.surfaces[key] = conv.id;
    bindingStore.save(bindings);
  }

  clearPendingProjectAssignment(home);
  log.info("replayed pending project assignment", { surfaceId: intent.surfaceId, sessionId: conv.id });
}
