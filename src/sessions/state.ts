import type { SessionState } from "./types.ts";
import { statePath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";

function isValidExecutionEnvironment(value: unknown): boolean {
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
 * Load session state from disk.
 * Returns null if the session doesn't exist.
 * Throws if state exists but lacks a valid executionEnvironment.
 */
export function loadState(home: string, id: string): SessionState | null {
  const state = loadJsonFile<SessionState | null>(statePath(home, id), null);
  return validateState(state);
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
 */
export function saveState(home: string, state: SessionState): void {
  saveJsonFile(statePath(home, state.id), state);
}
