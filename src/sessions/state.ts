import { readFileSync } from "node:fs";
import type { ConversationState, ConversationId, SessionState } from "./types.ts";
import type { ExecutionEnvironment } from "./environment.ts";
import { validateConversationId } from "./conversation.ts";
import { statePath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";

export function isValidExecutionEnvironment(value: unknown): value is ExecutionEnvironment {
  if (value === null || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  if (env.kind === "personal") return true;
  if (env.kind === "project") return typeof env.projectRoot === "string" && env.projectRoot.length > 0;
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
  if (raw === null || typeof raw !== "object") {
    throw new Error(`conversation ${id} state is not an object`);
  }
  const state = raw as Record<string, unknown>;
  if (!isValidExecutionEnvironment(state.executionEnvironment)) {
    throw new Error(`conversation ${id} has missing or invalid executionEnvironment`);
  }
  const createdAt = validateCreatedAt(state.createdAt);
  const title = validateTitle(state.title);
  if (state.id !== undefined && (typeof state.id !== "string" || state.id !== id)) {
    throw new Error(`conversation ${id} state file id mismatch: ${String(state.id)}`);
  }
  return {
    id,
    createdAt,
    title,
    executionEnvironment: state.executionEnvironment,
  };
}

function validateState(state: SessionState | null): SessionState | null {
  if (state === null) return null;
  if (!isValidExecutionEnvironment(state.executionEnvironment)) {
    throw new Error(`session ${state.id} has missing or invalid executionEnvironment`);
  }
  return state;
}

/**
 * Load canonical conversation state from disk, dropping migration-only legacy
 * fields (chatId, topicId, modelName, thinkingLevel, projectDir) from the
 * returned object.
 * Returns null if the conversation doesn't exist or is an internal session.
 * Throws if state exists but lacks a valid executionEnvironment.
 */
export function loadConversationState(home: string, id: string): ConversationState | null {
  validateConversationId(id);
  const raw = loadJsonFile<SessionState | null>(statePath(home, id), null);
  if (raw === null) return null;
  const state = validateConversationState(id as ConversationId, raw);
  // Internal sessions (e.g. dreaming) are never bound to a Surface.
  if (raw.chatId === 0) return null;
  // The directory name is the source of truth for the conversation identity.
  // The JSON id field is only validated, never used as a path component.
  return state;
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
  const state = loadJsonFile<SessionState | null>(statePath(home, id), null);
  const validated = validateState(state);
  if (validated === null) return null;
  if (validated.id !== id) {
    throw new Error(`session ${id} state file id mismatch: ${String(validated.id)}`);
  }
  return validated;
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
