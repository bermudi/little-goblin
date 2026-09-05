/**
 * Deployment MCP selection store — the sole writer of the `mcp` section in
 * `goblin.json5`.
 *
 * Owner: McpSelectionStore (this module).
 * Lifetime: deployment (process config, survives restarts via goblin.json5).
 * Authority: `goblin.json5` `mcp` section. `loadConfig()` remains the reader;
 * this module is the only writer. Commands never touch the file directly —
 * they call `setMcpServerEnabled()` here.
 * Persistence: `$GOBLIN_HOME/goblin.json5` via `goblinConfigPath()` +
 * `atomicWrite()` (tmp + fsync + rename, mode-preserving). Lock file
 * `<config>.lock` serializes intra-process writers; a pre-write re-read
 * aborts on concurrent manual edits instead of silently clobbering them.
 *
 * Selection semantics (decision 0042: mcporter owns transport/config, Goblin
 * only selects servers):
 * - `enabled: undefined` = every server in the mcporter gateway config is on.
 * - `disabledServers` is a deny-list applied after `enabled`. Deny wins.
 * - Enabling removes the name from the deny-list (and ensures it is in the
 *   allow-list when an allow-list exists). It never widens an allow-list
 *   from a pure deny state.
 * - Disabling adds to the deny-list (and removes from the allow-list when
 *   one exists).
 * - An enable that leaves the section empty persists `mcp: {}` so a restart
 *   still sees MCP configured. A disable that leaves it empty drops the
 *   section (MCP stays unconfigured until explicitly enabled).
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import JSON5 from "json5";
import { McpConfigSchema, type McpConfig } from "../schema.ts";
import { goblinConfigLockPath, goblinConfigPath } from "../sessions/paths.ts";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";

/**
 * Read the operator's goblin.json5 from disk as unparsed JSON5 text.
 * Throws when the file is missing — callers surface that as an error reply.
 */
function readRawConfigText(goblinHome: string): string {
  const path = goblinConfigPath(goblinHome);
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

/**
 * Validate an mcp section against the config schema. Returns the parsed
 * McpConfig (with schema defaults applied) or throws with a compact message.
 */
export function validateMcpSection(value: unknown): McpConfig {
  const parsed = McpConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`mcp config validation failed: ${issues}`);
  }
  return parsed.data;
}

/**
 * Human-readable selection summary with deny-wins honesty.
 *
 * Centralizes the formatting previously duplicated (with nested ternaries)
 * in `doctor.ts` and `commands/registry.ts`. When both lists are present the
 * effective selection (allow minus deny) is shown first, with the raw
 * allow/deny lists retained so an overlapping server is never displayed as
 * selected while actually filtered out.
 */
export function formatMcpSelection(config: McpConfig): string {
  const enabled = config.enabled;
  const disabled = config.disabledServers ?? [];
  if (enabled === undefined) {
    if (disabled.length === 0) return "all servers in the gateway config";
    return `all servers except: ${disabled.join(", ")}`;
  }
  if (disabled.length === 0) {
    if (enabled.length === 0) return "none (empty allow-list)";
    return enabled.join(", ");
  }
  const denied = new Set(disabled);
  const effective = enabled.filter((n) => !denied.has(n));
  const effectiveText = effective.length > 0 ? effective.join(", ") : "(none)";
  const allowText = enabled.length > 0 ? enabled.join(", ") : "(empty)";
  return `${effectiveText} (allow-list: ${allowText}; denied: ${disabled.join(", ")})`;
}

/** Path to the cooperative lock file serializing goblin.json5 MCP writers. */
function lockPathFor(goblinHome: string): string {
  return goblinConfigLockPath(goblinHome);
}

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
 * Acquire the goblin.json5 MCP lock via exclusive creation (`"wx"` — an
 * atomic no-overwrite reservation, not replacement). Stale locks older than
 * 10s are reaped so a crashed writer cannot wedge future /mcp mutations.
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
        throw new Error(
          `Config is locked (${lockPath}); another /mcp update is in progress. Retry shortly.`,
        );
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
 * Enable or disable one mcporter server in goblin.json5 and persist the file.
 *
 * Only mutates the `mcp` section; all other top-level keys (including
 * credentials) are preserved byte-for-byte apart from JSON5 round-trip
 * (comments excluded). Writes via `atomicWrite` (mode-preserving) under the
 * MCP lock, with a pre-write re-read that aborts on concurrent manual edits
 * instead of silently losing them.
 *
 * The service still requires a restart for tool registration changes; the
 * caller refreshes the in-memory catalog for immediate visibility.
 */
export function setMcpServerEnabled(
  goblinHome: string,
  server: string,
  enabled: boolean,
): { config: McpConfig; path: string } {
  const path = goblinConfigPath(goblinHome);
  const lockPath = lockPathFor(goblinHome);
  acquireLockSync(lockPath);
  try {
    const originalText = readRawConfigText(goblinHome);
    const raw = JSON5.parse(originalText) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Config file does not contain a top-level object");
    }

    const section = (raw.mcp ?? {}) as Record<string, unknown>;
    const current = validateMcpSection(section);

    let allow = current.enabled ? [...current.enabled] : undefined;
    const disabled = new Set(
      "disabledServers" in section && Array.isArray(section.disabledServers)
        ? section.disabledServers.filter((n): n is string => typeof n === "string")
        : [],
    );

    if (enabled) {
      disabled.delete(server);
      if (allow !== undefined && !allow.includes(server)) allow = [...allow, server];
    } else {
      disabled.add(server);
      if (allow !== undefined) allow = allow.filter((n) => n !== server);
    }

    const next: Record<string, unknown> = { ...section };
    if (allow !== undefined) next.enabled = allow;
    else delete next.enabled;
    if (disabled.size > 0) next.disabledServers = [...disabled].sort();
    else delete next.disabledServers;

    // An enable that empties the section must persist `mcp: {}` so a restart
    // still sees MCP configured. A disable that empties it drops the section.
    if (Object.keys(next).length === 0) {
      if (enabled) raw.mcp = next;
      else delete raw.mcp;
    } else {
      raw.mcp = next;
    }

    // Re-validate the merged section so a bad write can never persist.
    validateMcpSection(next);

    // Compare-and-swap: abort when a manual edit landed between our read and
    // the write instead of silently clobbering unrelated settings.
    let currentText: string;
    try {
      currentText = readFileSync(path, "utf-8");
    } catch (err) {
      throw new Error(
        `MCP config update aborted: cannot re-read config for conflict check: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (currentText !== originalText) {
      log.warn("mcp config write conflict: file changed during update", { path });
      throw new Error("Config changed during update (manual edit detected); retry /mcp enable|disable.");
    }

    atomicWrite(path, JSON5.stringify(raw, { space: 2 }) + "\n");
    return { config: validateMcpSection(next), path };
  } finally {
    releaseLockSync(lockPath);
  }
}
