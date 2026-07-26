/**
 * Single monotonic `stateVersion` for `$GOBLIN_HOME/state/` persisted layout.
 *
 * The filesystem is versioned independently of the memory SQLite schema.
 * Migrations are offline (run by `bun run migrate` while the service is stopped);
 * startup only checks the version and refuses to poll on mismatch.
 */

import { readFileSync } from "node:fs";
import { atomicWrite } from "./fs.ts";
import { log } from "./log.ts";

export const CURRENT_STATE_VERSION = 2;

export interface StateVersionFile {
  version: number;
}

export function stateVersionPath(home: string): string {
  return `${home}/state/state-version.json`;
}

/**
 * Read the persisted state version. Missing or malformed files return 0,
 * indicating "before versioning".
 */
export function readStateVersion(home: string): number {
  try {
    const raw = readFileSync(stateVersionPath(home), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
      const version = Number((parsed as Record<string, unknown>).version);
      if (Number.isSafeInteger(version) && version >= 0) return version;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    log.warn("malformed state version file, treating as 0", { home, error: String(e) });
  }
  return 0;
}

/**
 * Atomically write the state version.
 */
export function writeStateVersion(home: string, version: number): void {
  atomicWrite(stateVersionPath(home), JSON.stringify({ version }, null, 2) + "\n");
}
