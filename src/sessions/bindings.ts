import { readFileSync } from "node:fs";
import type { BindingsFile } from "./types.ts";
import { configPath } from "./paths.ts";
import { atomicWrite } from "../fs.ts";

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
  try {
    const raw = readFileSync(pathFor(home), "utf-8");
    return JSON.parse(raw) as BindingsFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULT_BINDINGS);
    }
    throw e;
  }
}

/**
 * Save bindings atomically via `atomicWrite` (tmp + fsync + rename with
 * symlink resolution). See `src/fs.ts`.
 */
export function saveBindings(home: string, bindings: BindingsFile): void {
  atomicWrite(pathFor(home), JSON.stringify(bindings, null, 2) + "\n");
}
