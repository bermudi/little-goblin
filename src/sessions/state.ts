import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState } from "./types.ts";
import { sessionDir, statePath } from "./paths.ts";

/**
 * Load session state from disk.
 * Returns null if the session doesn't exist.
 */
export function loadState(home: string, id: string): SessionState | null {
  const path = statePath(home, id);
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw e;
  }
}

/**
 * Save session state atomically (write to tmp, then rename).
 */
export function saveState(home: string, state: SessionState): void {
  const dir = sessionDir(home, state.id);
  mkdirSync(dir, { recursive: true });

  const finalPath = statePath(home, state.id);
  const tmpPath = join(dir, `.state-${state.id}.tmp`);

  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  // Atomic rename on POSIX
  renameSync(tmpPath, finalPath);
}
