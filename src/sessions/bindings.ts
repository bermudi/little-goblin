import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BindingsFile } from "./types.ts";
import { configPath } from "./paths.ts";

const DEFAULT_BINDINGS: BindingsFile = {
  dm: {},
  topics: {},
  supergroups: {},
};

function pathFor(home: string): string {
  return configPath(home);
}

/**
 * Load the root config.json (bindings). Returns default if missing.
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
 * Save bindings atomically (write to unique tmp, then rename).
 * Unique tmp name prevents clobber in any future concurrent scenario.
 */
export function saveBindings(home: string, bindings: BindingsFile): void {
  const finalPath = pathFor(home);
  const tmpPath = join(home, `.config.${randomUUID().slice(0, 8)}.tmp`);

  writeFileSync(tmpPath, JSON.stringify(bindings, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
}
