/**
 * Coordinated `goblin.json5` file access — the one deep mutation path for
 * deployment config writers.
 *
 * Owner: this module (coordination only; section ownership stays with callers:
 * `McpSelectionStore` owns `mcp`, Settings store owns `devin`).
 * Lifetime: deployment (process config, survives restarts via goblin.json5).
 * Authority: `goblin.json5` file. Readers use `loadConfig()` or section
 * projections; writers go through `updateGoblinConfig()` here so MCP and
 * Settings mutations share one lock, one compare-and-swap, and one
 * mode-preserving durable write.
 * Persistence: `$GOBLIN_HOME/goblin.json5` via `goblinConfigPath()` +
 * `atomicWrite()` (tmp + fsync + rename, mode-preserving). Lock file
 * `<config>.lock` serializes writers; a pre-write re-read aborts on
 * concurrent edits instead of silently clobbering them.
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import JSON5 from "json5";
import { goblinConfigLockPath, goblinConfigPath } from "./sessions/paths.ts";
import { atomicWrite } from "./fs.ts";
import { log } from "./log.ts";

const LOCK_STALE_MS = 10_000;

function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy-wait fallback when Atomics.wait is unavailable.
    }
  }
}

/**
 * Acquire the goblin.json5 writer lock via exclusive creation (`"wx"` — an
 * atomic no-overwrite reservation, not replacement). Stale locks older than
 * 10s are reaped so a crashed writer cannot wedge future mutations.
 * Throws after ~5s when another writer holds the lock.
 */
function acquireLockSync(lockPath: string): void {
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf-8");
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            rmSync(lockPath, { force: true });
          } catch {
            // Another writer reaped first; retry acquisition.
          }
          continue;
        }
      } catch {
        // Lock vanished between open and stat; retry immediately.
        continue;
      }
      if (Date.now() - start > 5000) {
        throw new Error(`Config is locked (${lockPath}); another config update is in progress. Retry shortly.`);
      }
      sleepSyncMs(50);
    }
  }
}

function releaseLockSync(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort: a stale-reaped lock is already gone.
  }
}

/**
 * Read the operator's goblin.json5 from disk as unparsed JSON5 text.
 * Throws when the file is missing — callers surface that as an error reply.
 */
export function readGoblinConfigText(goblinHome: string): string {
  const path = goblinConfigPath(goblinHome);
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

/** Content revision for stale-write detection; changes on any file edit. */
export function revisionForConfigText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Apply `mutate` to the parsed top-level config object and durably commit.
 *
 * Serializes writers with the shared lock, optionally rejects a stale
 * `expectedRevision` before parsing, revalidates via the caller's mutate,
 * aborts when the file changed between read and write, and persists with
 * mode-preserving `atomicWrite`. Only the caller's section is mutated;
 * unrelated top-level keys are preserved by round-trip.
 */
export function updateGoblinConfig(
  goblinHome: string,
  mutate: (raw: Record<string, unknown>) => void,
  options?: { expectedRevision?: string },
): { text: string; revision: string } {
  const path = goblinConfigPath(goblinHome);
  const lockPath = goblinConfigLockPath(goblinHome);
  acquireLockSync(lockPath);
  try {
    const originalText = readGoblinConfigText(goblinHome);
    if (options?.expectedRevision !== undefined && revisionForConfigText(originalText) !== options.expectedRevision) {
      log.warn("goblin config write conflict: stale revision", { path });
      throw new Error("Settings save aborted: stale revision; re-read settings and retry.");
    }
    const raw = JSON5.parse(originalText) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Config file does not contain a top-level object");
    }
    mutate(raw);
    const nextText = JSON5.stringify(raw, { space: 2 }) + "\n";
    let currentText: string;
    try {
      currentText = readFileSync(path, "utf-8");
    } catch (err) {
      throw new Error(
        `Config update aborted: cannot re-read config for conflict check: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (currentText !== originalText) {
      log.warn("goblin config write conflict: file changed during update", { path });
      throw new Error("Config changed during update (manual edit detected); retry the update.");
    }
    atomicWrite(path, nextText);
    return { text: nextText, revision: revisionForConfigText(nextText) };
  } finally {
    releaseLockSync(lockPath);
  }
}
