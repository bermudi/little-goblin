import type { ConversationState, ConversationId } from "./types.ts";
import {
  assertInternalSessionId,
  assertInternalSessionState,
  type InternalSessionState,
} from "./internal-session.ts";
import type { ExecutionEnvironment } from "./environment.ts";
import { isCanonicalProjectRoot } from "./environment.ts";
import { validateConversationId } from "./conversation.ts";
import { statePath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidExecutionEnvironment(value: unknown): value is ExecutionEnvironment {
  if (!isRecord(value)) return false;
  if (value.kind === "personal") {
    return Object.keys(value).length === 1;
  }
  if (value.kind === "project") {
    return Object.keys(value).length === 2 && isCanonicalProjectRoot(value.projectRoot);
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateCreatedAt(value: unknown): string {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`conversation has missing or invalid createdAt: ${String(value)}`);
  }
  return value;
}

function validateTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`conversation has invalid title: ${String(value)}`);
  }
  return value;
}

function validateConversationState(id: ConversationId, raw: unknown): ConversationState {
  if (!isRecord(raw)) {
    throw new Error(`conversation ${id} state is not an object`);
  }
  const validKeys = new Set(["id", "createdAt", "title", "executionEnvironment"]);
  for (const key of Object.keys(raw)) {
    if (!validKeys.has(key)) {
      throw new Error(`conversation ${id} has unexpected state field: ${key}`);
    }
  }
  if (typeof raw.id !== "string" || raw.id !== id) {
    throw new Error(`conversation ${id} state file id mismatch: ${String(raw.id)}`);
  }
  if (!isValidExecutionEnvironment(raw.executionEnvironment)) {
    throw new Error(`conversation ${id} has missing or invalid executionEnvironment`);
  }
  const createdAt = validateCreatedAt(raw.createdAt);
  const title = validateTitle(raw.title);
  return {
    id,
    createdAt,
    title,
    executionEnvironment: raw.executionEnvironment,
  };
}

/**
 * Load canonical conversation state from disk, dropping migration-only legacy
 * fields (chatId, topicId, modelName, thinkingLevel, projectDir) from the
 * returned object.
 * Returns null only when the canonical Conversation state file is absent.
 * Throws when a present record is malformed, legacy, or otherwise invalid.
 */
export function loadConversationState(home: string, id: string): ConversationState | null {
  validateConversationId(id);
  const raw = loadJsonFile<unknown | undefined>(statePath(home, id), undefined);
  if (raw === undefined) return null;
  // `id` is already a canonical ten-hex Conversation ID here. Internal
  // compatibility records use reserved `__…__` IDs; a chatId:0 record at a
  // Conversation path is corrupt authority, never a missing Conversation.
  return validateConversationState(id as ConversationId, raw);
}

/**
 * Save canonical conversation state atomically (write to tmp, then rename).
 * Only the canonical fields are written; legacy fields are stripped.
 */
export function saveConversationState(home: string, state: ConversationState): void {
  validateConversationId(state.id);
  const canonical = validateConversationState(state.id, state);
  saveJsonFile(statePath(home, state.id), canonical);
}

/** Load and validate the explicit Surface-free internal runtime record. */
export function loadInternalSessionState(home: string, id: string): InternalSessionState | null {
  assertInternalSessionId(id);
  const state = loadJsonFile<unknown | undefined>(statePath(home, id), undefined);
  if (state === undefined) return null;
  assertInternalSessionState(state);
  if (state.id !== id) {
    throw new Error(`internal session ${id} state file id mismatch: ${state.id}`);
  }
  return state;
}

/** Persist the explicit Surface-free internal runtime record atomically. */
export function saveInternalSessionState(home: string, state: InternalSessionState): void {
  assertInternalSessionId(state.id);
  assertInternalSessionState(state);
  saveJsonFile(statePath(home, state.id), state);
}
