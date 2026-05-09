/**
 * Single source of truth for pi infrastructure services and filesystem paths.
 *
 * Both `AgentRunner` and `SubagentRunner` import from here, eliminating the
 * cross-module import from `subagents/` into `agent/paths.ts`.
 */

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
 * Construct pi's infrastructure services with paths under `$GOBLIN_HOME/goblin/`.
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
  return join(home, "workdir");
}

/** Path to the goblin directory for pi-ai configuration. */
export function piAgentDir(home: string): string {
  return join(home, "goblin");
}

/** Path to the AGENTS.md file at goblin home root. */
export function agentsMdPath(home: string): string {
  return join(home, "AGENTS.md");
}
