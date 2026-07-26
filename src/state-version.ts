/**
 * Single monotonic `stateVersion` for `$GOBLIN_HOME/state/` persisted layout.
 *
 * The filesystem is versioned independently of the memory SQLite schema.
 * Migrations are offline (run by `bun run migrate` while the service is stopped);
 * startup only checks the version and refuses to poll on mismatch.
 */

import { readFileSync } from "node:fs";
import { atomicWrite } from "./fs.ts";

export const CURRENT_STATE_VERSION = 2;

export interface StateVersionFile {
  version: number;
}

export function stateVersionPath(home: string): string {
  return `${home}/state/state-version.json`;
}

/**
 * Read the persisted state version. Only an absent file returns 0, indicating
 * "before versioning". Malformed JSON, an invalid schema, a negative or
 * non-integer value, or a version newer than the running code fail loudly.
 */
export function readStateVersion(home: string): number {
  const path = stateVersionPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new Error(`cannot read state version file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`malformed state version file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (parsed === null || typeof parsed !== "object" || !("version" in parsed)) {
    throw new Error(`invalid state version schema in ${path}: missing "version" field`);
  }

  const versionValue = (parsed as Record<string, unknown>).version;
  const version = Number(versionValue);
  if (!Number.isSafeInteger(version)) {
    throw new Error(`invalid state version in ${path}: ${versionValue} is not a safe integer`);
  }
  if (version < 0) {
    throw new Error(`invalid state version in ${path}: ${version} is negative`);
  }
  if (version > CURRENT_STATE_VERSION) {
    throw new Error(`state version ${version} in ${path} is newer than supported ${CURRENT_STATE_VERSION}`);
  }

  return version;
}

/**
 * Atomically write the state version.
 */
export function writeStateVersion(home: string, version: number): void {
  atomicWrite(stateVersionPath(home), JSON.stringify({ version }, null, 2) + "\n");
}
