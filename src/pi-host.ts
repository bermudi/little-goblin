/**
 * Single source of truth for pi infrastructure services and filesystem paths.
 *
 * Both `AgentRunner` and `SubagentRunner` import from here, eliminating the
 * cross-module import from `subagents/` into `agent/paths.ts`.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Pi service factory
// ---------------------------------------------------------------------------

/** The trio of pi services shared across agent runners and subagents. */
export interface PiServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
}

/**
 * Construct pi's infrastructure services with paths under `$GOBLIN_HOME/state/pi/`.
 *
 * Stateless — returns new instances on every call. Caching is the caller's
 * responsibility.
 */
export function createPiServices(home: string): PiServices {
  const dir = piAgentDir(home);
  const authStorage = AuthStorage.create(join(dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(dir, "models.json"));
  const settingsManager = SettingsManager.inMemory({});
  return { authStorage, modelRegistry, settingsManager };
}

// ---------------------------------------------------------------------------
// Path helpers (moved from agent/paths.ts)
// ---------------------------------------------------------------------------

/** Path to the workdir directory for sandboxed execution. */
export function workdirPath(home: string): string {
  return join(home, "scratch", "workdir");
}

/** Path to the pi directory for pi-ai configuration (auth.json, models.json). */
export function piAgentDir(home: string): string {
  return join(home, "state", "pi");
}

/** Path to the AGENTS.md file in the goblin workspace. */
export function agentsMdPath(home: string): string {
  return join(home, "workspace", "AGENTS.md");
}

/** Path to goblin's skills directory in the goblin workspace. */
export function skillsPath(home: string): string {
  return join(home, "workspace", "skills");
}

/**
 * Find the most recently modified `.jsonl` session file in `piSessionDir`.
 *
 * This mirrors pi's internal `findMostRecentSession` but is cwd-agnostic: it
 * does NOT filter by the on-disk `header.cwd`, because goblin pins the session
 * directory to sessions/<id>/pi (the directory is the scope) and the runner's
 * resolved cwd can legitimately differ from a prior file's header — e.g. after
 * a /project bind or a /model switch. Cwd-gated filtering (which
 * SessionManager.continueRecent performs) silently misses in that case and
 * creates a fresh empty session, losing history.
 *
 * Used together with SessionManager.open(file, dir, cwd) to resume history
 * across project and model switches. Returns null on ENOENT or empty dir.
 */
export function findMostRecentPiSession(piSessionDir: string): string | null {
  if (!existsSync(piSessionDir)) return null;
  let files: string[];
  try {
    files = readdirSync(piSessionDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const path = join(piSessionDir, f);
    const mtime = statSync(path).mtime.getTime();
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best ? best.path : null;
}

/** Path to the SOUL.md file in the goblin workspace. */
export function soulMdPath(home: string): string {
  return join(home, "workspace", "SOUL.md");
}

/** Path to the optional HEARTBEAT.md file in the goblin workspace. */
export function heartbeatMdPath(home: string): string {
  return join(home, "workspace", "HEARTBEAT.md");
}
