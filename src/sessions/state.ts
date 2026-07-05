import { readFileSync } from "node:fs";
import type { SessionState } from "./types.ts";
import { statePath } from "./paths.ts";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";

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
    if (e instanceof SyntaxError) {
      log.warn("malformed session state, treating as missing", { path, error: String(e) });
      return null;
    }
    throw e;
  }
}

/**
 * Save session state atomically (write to tmp, then rename).
 */
export function saveState(home: string, state: SessionState): void {
  atomicWrite(statePath(home, state.id), JSON.stringify(state, null, 2) + "\n");
}
