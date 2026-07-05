import { readFileSync } from "node:fs";
import type { BindingsFile } from "./types.ts";
import { configPath } from "./paths.ts";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";

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
  const path = pathFor(home);
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as BindingsFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULT_BINDINGS);
    }
    if (e instanceof SyntaxError) {
      log.warn("malformed bindings.json, returning default", { path, error: String(e) });
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
