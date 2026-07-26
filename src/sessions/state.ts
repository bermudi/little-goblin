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
 * Returns null if the conversation doesn't exist.
 * Throws if state exists but lacks a valid executionEnvironment.
 */
export function loadConversationState(home: string, id: string): ConversationState | null {
  validateConversationId(id);
  const raw = loadJsonFile<SessionState | null>(statePath(home, id), null);
  if (raw === null) return null;
  if (!isValidExecutionEnvironment(raw.executionEnvironment)) {
    throw new Error(`conversation ${id} has missing or invalid executionEnvironment`);
  }
  if (raw.id !== undefined && raw.id !== id) {
    throw new Error(`conversation ${id} state file id mismatch: ${String(raw.id)}`);
  }
  // The directory name is the source of truth for the conversation identity.
  // The JSON id field is only validated, never used as a path component.
  return {
    id: id as ConversationId,
    createdAt: raw.createdAt,
    title: raw.title,
    executionEnvironment: raw.executionEnvironment,
  };
}

/**
 * Save canonical conversation state atomically (write to tmp, then rename).
 * Only the canonical fields are written; legacy fields are stripped.
 */
export function saveConversationState(home: string, state: ConversationState): void {
  validateConversationId(state.id);
  if (!isValidExecutionEnvironment(state.executionEnvironment)) {
    throw new Error(`conversation ${state.id} has missing or invalid executionEnvironment`);
  }
  const canonical = {
    id: state.id,
    createdAt: state.createdAt,
    title: state.title,
    executionEnvironment: state.executionEnvironment,
  };
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
 */
export function loadLegacyState(home: string, id: string): SessionState | null {
  return loadJsonFile<SessionState | null>(statePath(home, id), null);
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
