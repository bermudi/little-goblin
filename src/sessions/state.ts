import type { SessionState } from "./types.ts";
import { statePath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";

/**
 * Load session state from disk.
 * Returns null if the session doesn't exist.
 */
export function loadState(home: string, id: string): SessionState | null {
  return loadJsonFile<SessionState | null>(statePath(home, id), null);
}

/**
 * Save session state atomically (write to tmp, then rename).
 */
export function saveState(home: string, state: SessionState): void {
  saveJsonFile(statePath(home, state.id), state);
}
