/**
 * Pending project-assignment intent storage and helpers.
 *
 * A pending intent captures the durable commit point for first project
 * assignment: SurfaceId, optional prior Conversation ID, planned future
 * Conversation ID, and canonical project root. It is persisted atomically
 * before the Conversation directory or binding is mutated, and cleared once
 * the assignment is complete.
 */

import { unlinkSync } from "node:fs";
import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId, parseSurfaceId } from "../surface.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { pendingProjectAssignmentPath } from "./paths.ts";
import { ConversationStore } from "./conversation-store.ts";
import type { ConversationId } from "./types.ts";
import { isValidConversationId, validateConversationId } from "./conversation.ts";
import { assertCanonicalProjectRoot, environmentsEqual, projectEnvironment } from "./environment.ts";
import { getProjectRoot, bindProjectRoot } from "./topic-settings.ts";
import { validateBindings, type BindingStore } from "./bindings.ts";

export interface ProjectAssignmentIntent {
  version: 1;
  surfaceId: SurfaceId;
  previousSessionId?: string;
  plannedSessionId: string;
  projectRoot: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPendingIntent(value: unknown, path: string): asserts value is ProjectAssignmentIntent {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(`invalid pending project assignment at ${path}`);
  }
  const validKeys = new Set(["version", "surfaceId", "previousSessionId", "plannedSessionId", "projectRoot"]);
  for (const key of Object.keys(value)) {
    if (!validKeys.has(key)) {
      throw new Error(`invalid pending project assignment field ${key} at ${path}`);
    }
  }
  if (typeof value.surfaceId !== "string") {
    throw new Error(`pending project assignment has invalid surface id at ${path}`);
  }
  parseSurfaceId(value.surfaceId);
  if (typeof value.plannedSessionId !== "string" || !isValidConversationId(value.plannedSessionId)) {
    throw new Error(`pending project assignment has invalid planned conversation id at ${path}`);
  }
  if (value.previousSessionId !== undefined && (
    typeof value.previousSessionId !== "string" || !isValidConversationId(value.previousSessionId)
  )) {
    throw new Error(`pending project assignment has invalid previous conversation id at ${path}`);
  }
  try {
    assertCanonicalProjectRoot(value.projectRoot, "pending project assignment projectRoot");
  } catch (error) {
    throw new Error(`pending project assignment has invalid project root at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadPendingProjectAssignment(home: string): ProjectAssignmentIntent | null {
  const path = pendingProjectAssignmentPath(home);
  const raw = loadJsonFile<unknown | undefined>(path, undefined);
  if (raw === undefined) return null;
  assertPendingIntent(raw, path);
  return raw;
}

export function savePendingProjectAssignment(home: string, intent: ProjectAssignmentIntent): void {
  assertPendingIntent(intent, pendingProjectAssignmentPath(home));
  saveJsonFile(pendingProjectAssignmentPath(home), intent);
  log.info("pending project assignment persisted", { surfaceId: intent.surfaceId, plannedSessionId: intent.plannedSessionId });
}

export function clearPendingProjectAssignment(home: string): void {
  const path = pendingProjectAssignmentPath(home);
  const intent = loadPendingProjectAssignment(home);
  if (intent === null) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  log.info("pending project assignment cleared", { surfaceId: intent.surfaceId });
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
      throw new Error(`pending assignment conversation ${id} exists with a different execution environment`);
    }
    return existing;
  }
  // `createPlannedWithId` rejects any present state.json (including malformed
  // or internal state) and every directory artifact not producible before the
  // assignment's own state write. It is the sole partial-directory recovery
  // path; ordinary creation never adopts a pre-existing directory.
  return store.createPlannedWithId(projectEnvironment(projectRoot), id as ConversationId);
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

  const surface = parseSurfaceId(intent.surfaceId);
  const key = surfaceId(surface);
  const bindings = bindingStore.load();
  validateBindings(bindings);
  const boundId = bindings.surfaces[key];

  // Validate every existing authority source before creating Q or editing any
  // other file. An intent only authorizes its own planned ID and, when present,
  // its recorded predecessor; it never authorizes choosing another matching
  // project conversation as a winner.
  if (boundId !== undefined && boundId !== intent.plannedSessionId && boundId !== intent.previousSessionId) {
    throw new Error(
      `pending assignment replay conflict: surface ${intent.surfaceId} is bound to ${boundId}, expected ${intent.previousSessionId ?? "(none)"} or ${intent.plannedSessionId}`,
    );
  }
  const settingsRoot = getProjectRoot(home, surface);
  if (settingsRoot !== undefined && settingsRoot !== intent.projectRoot) {
    throw new Error(
      `pending assignment replay conflict: surface ${intent.surfaceId} is assigned to ${settingsRoot}, expected ${intent.projectRoot}`,
    );
  }

  const conv = createOrVerifyProjectSession(store, surface, intent.plannedSessionId, intent.projectRoot);

  if (settingsRoot === undefined) {
    bindProjectRoot(home, surface, intent.projectRoot);
  }
  if (boundId !== conv.id) {
    bindings.surfaces[key] = conv.id;
    bindingStore.save(bindings);
  }

  clearPendingProjectAssignment(home);
  log.info("replayed pending project assignment", { surfaceId: intent.surfaceId, sessionId: conv.id });
}
