import type { BindingsFile } from "./types.ts";
import { configPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";

const DEFAULT_BINDINGS: BindingsFile = {
  dm: {},
  topics: {},
  supergroups: {},
};

function pathFor(home: string): string {
  return configPath(home);
}

/**
 * Load the root bindings file (state/bindings.json). Returns default if missing.
 */
export function loadBindings(home: string): BindingsFile {
  return loadJsonFile(pathFor(home), structuredClone(DEFAULT_BINDINGS));
}

/**
 * Save bindings atomically via `atomicWrite` (tmp + fsync + rename with
 * symlink resolution). See `src/fs.ts`.
 */
export function saveBindings(home: string, bindings: BindingsFile): void {
  saveJsonFile(pathFor(home), bindings);
}
