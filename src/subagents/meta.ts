/**
 * Subagent filesystem helpers that did not move to the host-owned record store.
 *
 * `findSessionFile` is a lexical helper for locating the newest `.jsonl` Pi
 * session file inside a run directory. The validated atomic persistence
 * machinery previously in this module moved to `src/delegated-work/store.ts`
 * under decision 0045.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { boundedError, log } from "../log.ts";

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Find the most recent `.jsonl` session file inside a directory.
 * Returns `null` when the directory or a session file is absent. Other
 * filesystem failures propagate so permission and I/O problems remain
 * diagnosable.
 */
export function findSessionFile(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().reverse();
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") return null;
    log.error("subagent session lookup failed", { path: dir, ...boundedError(err) });
    throw err;
  }

  const newest = files[0];
  return newest === undefined ? null : join(dir, newest);
}
