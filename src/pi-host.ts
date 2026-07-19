/**
 * Pi infrastructure services and pi-specific filesystem paths.
 *
 * Both `AgentRunner` and `SubagentRunner` import from here, eliminating the
 * cross-module import from `subagents/` into `agent/paths.ts`.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Pi service factory
// ---------------------------------------------------------------------------

/**
 * The pi services shared across agent runners and subagents.
 *
 * `modelRuntime` is the canonical async auth/model facade (pi-coding-agent
 * 0.80.8+). It supersedes the old `AuthStorage` + `ModelRegistry` pair: a
 * single `ModelRuntime` owns credential resolution (auth.json) and the model
 * catalog (models.json), and is exactly what `createAgentSession` expects.
 */
export interface PiServices {
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
}

/**
 * Construct pi's infrastructure services with paths under `$GOBLIN_HOME/state/pi/`.
 *
 * Stateless — returns new instances on every call. Caching is the caller's
 * responsibility.
 */
export async function createPiServices(home: string): Promise<PiServices> {
  const dir = piAgentDir(home);
  // `allowModelNetwork: false` keeps session init offline: model auth/catalog
  // come from the built-in catalog + models.json, never a network refresh.
  // This matches the pre-0.80.8 `AuthStorage`/`ModelRegistry` behaviour and
  // avoids `ModelRuntime.create` blocking on a ~15s catalog refresh when the
  // network is slow or `PI_OFFLINE` is unset. Live catalog refresh (if wanted)
  // is a separate, on-demand concern (`/model`), not session startup.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({});
  return { modelRuntime, settingsManager };
}

// ---------------------------------------------------------------------------
// Pi-specific path helpers
// ---------------------------------------------------------------------------

/** Path to the pi directory for pi-ai configuration (auth.json, models.json). */
export function piAgentDir(home: string): string {
  return join(home, "state", "pi");
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
