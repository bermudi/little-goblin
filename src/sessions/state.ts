import { readFileSync } from "node:fs";
import type { ConversationState, ConversationId, SessionState } from "./types.ts";
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

function validateState(state: unknown, id: string): SessionState | null {
  if (state === undefined) return null;
  if (!isRecord(state)) {
    throw new Error(`session ${id} state is not an object`);
  }
  if (state.id !== id) {
    throw new Error(`session ${id} state file id mismatch: ${String(state.id)}`);
  }
  if (!isValidExecutionEnvironment(state.executionEnvironment)) {
    throw new Error(`session ${id} has missing or invalid executionEnvironment`);
  }
  return state as unknown as SessionState;
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

/**
 * Load session state from disk.
 * Returns null if the session doesn't exist.
 * Throws if state exists but lacks a valid executionEnvironment.
 *
 * @deprecated Use loadConversationState for canonical reads; SessionState is a
 * legacy compatibility shape.
 */
export function loadState(home: string, id: string): SessionState | null {
  const state = loadJsonFile<unknown | undefined>(statePath(home, id), undefined);
  return validateState(state, id);
}

/**
 * Load session state without validating executionEnvironment. Used only by
 * environment migration, which must read legacy state before rewriting it.
 * Malformed JSON is treated as a migration failure, not a default value.
 */
export function loadLegacyState(home: string, id: string): SessionState | null {
  const path = statePath(home, id);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return JSON.parse(raw) as SessionState;
}

/**
 * Save session state atomically (write to tmp, then rename).
 *
 * @deprecated Use saveConversationState for canonical writes; this preserves
 * legacy fields for compatibility callers only.
 */
export function saveState(home: string, state: SessionState): void {
  saveJsonFile(statePath(home, state.id), state);
}
