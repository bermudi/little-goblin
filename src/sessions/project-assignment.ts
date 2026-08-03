/**
 * Pending project-assignment intent storage and commit planning.
 *
 * A pending intent captures the durable commit point for first project
 * assignment: SurfaceId, optional prior Conversation ID, planned future
 * Conversation ID, and canonical project root. It is persisted atomically
 * before the Conversation directory or assignment authority is mutated, and
 * cleared once the assignment is complete.
 */

import { unlinkSync } from "node:fs";
import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId, parseSurfaceId } from "../surface.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { pendingProjectAssignmentPath } from "./paths.ts";
import { ConversationStore } from "./conversation-store.ts";
import type { BindingsFile, ConversationId, ConversationState } from "./types.ts";
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

/**
 * Fully validated assignment work that is safe to quiesce and then commit.
 * Planning may create only the intent-owned Conversation; it does not mutate
 * Surface settings, Bindings, or the pending intent.
 */
export interface PreparedProjectAssignment {
  readonly intent: ProjectAssignmentIntent;
  readonly surface: Surface;
  readonly conversation: ConversationState;
  readonly currentProjectRoot: string | undefined;
  readonly currentConversationId: ConversationId | undefined;
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

function createOrVerifyPlannedConversation(
  store: ConversationStore,
  id: string,
  projectRoot: string,
): ConversationState {
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

function cloneBindings(bindings: BindingsFile): BindingsFile {
  return { version: 1, surfaces: { ...bindings.surfaces } } as BindingsFile;
}

interface ProjectAssignmentAuthoritySnapshot {
  readonly bindings: BindingsFile;
  readonly projectRoot: string | undefined;
  readonly conversationId: ConversationId | undefined;
  readonly plannedOwnerSurfaceId: string | undefined;
}

function readProjectAssignmentAuthority(
  home: string,
  bindingStore: BindingStore,
  surface: Surface,
  plannedConversationId: string,
): ProjectAssignmentAuthoritySnapshot {
  const key = surfaceId(surface);
  const bindings = bindingStore.load();
  validateBindings(bindings);
  return {
    bindings,
    projectRoot: getProjectRoot(home, surface),
    conversationId: bindings.surfaces[key] as ConversationId | undefined,
    plannedOwnerSurfaceId: Object.entries(bindings.surfaces)
      .find(([candidateSurfaceId, conversationId]) => (
        candidateSurfaceId !== key && conversationId === plannedConversationId
      ))?.[0],
  };
}

function assertAssignmentAuthorityStable(
  prepared: PreparedProjectAssignment,
  authority: ProjectAssignmentAuthoritySnapshot,
): void {
  const key = surfaceId(prepared.surface);
  if (authority.projectRoot !== prepared.currentProjectRoot) {
    throw new Error(`pending assignment settings changed after planning for surface ${key}`);
  }
  if (authority.conversationId !== prepared.currentConversationId) {
    throw new Error(`pending assignment binding changed after planning for surface ${key}`);
  }
  if (authority.plannedOwnerSurfaceId !== undefined) {
    throw new Error(
      `pending assignment binding changed after planning: planned conversation is bound to ${authority.plannedOwnerSurfaceId}`,
    );
  }
}

function intentsEqual(left: ProjectAssignmentIntent, right: ProjectAssignmentIntent): boolean {
  return left.version === right.version
    && left.surfaceId === right.surfaceId
    && left.previousSessionId === right.previousSessionId
    && left.plannedSessionId === right.plannedSessionId
    && left.projectRoot === right.projectRoot;
}

/**
 * Validate a pending assignment and create or verify only its planned
 * Conversation. No Surface setting, Binding, or pending-intent write occurs.
 */
export function preparePendingProjectAssignment(
  home: string,
  store: ConversationStore,
  bindingStore: BindingStore,
): PreparedProjectAssignment | null {
  const intent = loadPendingProjectAssignment(home);
  if (intent === null) return null;

  const surface = parseSurfaceId(intent.surfaceId);
  const authority = readProjectAssignmentAuthority(
    home,
    bindingStore,
    surface,
    intent.plannedSessionId,
  );

  // An intent authorizes only its planned ID and its recorded predecessor. It
  // never authorizes choosing another matching project Conversation as winner.
  if (
    authority.conversationId !== undefined
    && authority.conversationId !== intent.plannedSessionId
    && authority.conversationId !== intent.previousSessionId
  ) {
    throw new Error(
      `pending assignment replay conflict: surface ${intent.surfaceId} is bound to ${authority.conversationId}, expected ${intent.previousSessionId ?? "(none)"} or ${intent.plannedSessionId}`,
    );
  }
  if (authority.projectRoot !== undefined && authority.projectRoot !== intent.projectRoot) {
    throw new Error(
      `pending assignment replay conflict: surface ${intent.surfaceId} is assigned to ${authority.projectRoot}, expected ${intent.projectRoot}`,
    );
  }
  if (authority.plannedOwnerSurfaceId !== undefined) {
    throw new Error(
      `pending assignment replay conflict: planned conversation ${intent.plannedSessionId} is bound to ${authority.plannedOwnerSurfaceId}`,
    );
  }

  // All existing authority has been validated before this sole planning write.
  const conversation = createOrVerifyPlannedConversation(store, intent.plannedSessionId, intent.projectRoot);
  return {
    intent,
    surface,
    conversation,
    currentProjectRoot: authority.projectRoot,
    currentConversationId: authority.conversationId,
  };
}

/**
 * Apply a previously prepared assignment. Callers with a live runtime host
 * must quiesce `currentConversationId` first when it differs from the planned
 * Conversation. Cold-start callers may apply directly because no host exists.
 */
export function applyPreparedProjectAssignment(
  home: string,
  bindingStore: BindingStore,
  prepared: PreparedProjectAssignment,
): ConversationState {
  const currentIntent = loadPendingProjectAssignment(home);
  if (currentIntent === null || !intentsEqual(currentIntent, prepared.intent)) {
    throw new Error("pending assignment changed after planning; refusing stale commit");
  }

  const key = surfaceId(prepared.surface);
  const authority = readProjectAssignmentAuthority(
    home,
    bindingStore,
    prepared.surface,
    prepared.conversation.id,
  );
  assertAssignmentAuthorityStable(prepared, authority);

  if (prepared.currentProjectRoot === undefined) {
    bindProjectRoot(home, prepared.surface, prepared.intent.projectRoot);
  }
  if (authority.conversationId !== prepared.conversation.id) {
    const next = cloneBindings(authority.bindings);
    next.surfaces[key] = prepared.conversation.id;
    bindingStore.save(next);
  }

  clearPendingProjectAssignment(home);
  log.info("replayed pending project assignment", {
    surfaceId: prepared.intent.surfaceId,
    conversationId: prepared.conversation.id,
  });
  return prepared.conversation;
}
