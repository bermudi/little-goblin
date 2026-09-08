/**
 * Saved deployment default → next ACP run (decision 0049).
 *
 * Owner: Settings launch integration (this module).
 * Lifetime: deployment (reads `goblin.json5` live at each admission; no
 * cached startup snapshot, so a save through the authenticated Settings path
 * changes the next admitted run without a restart).
 * Authority: `goblin.json5` `devin.defaultModel` via the sole Settings store
 * (`readDeploymentSettings` in `store.ts`). The legacy startup snapshot
 * (`externalAgents.devinModel`) is never consulted here. Each admitted Devin
 * run captures the resolved exact model in its delegated-run record; later
 * default changes never mutate admitted runs. Missing selection resolves to
 * `undefined` so the canonical ACP/delegated-work path rejects the launch
 * visibly without a record, process, or substitute. Non-ENOENT failures
 * propagate for the caller to surface; the tool converts them to a visible
 * launch error without a record or process.
 * Persistence: none in this module (canonical state stays in `goblin.json5`).
 */

import { readDeploymentSettings, SettingsStoreError } from "./store.ts";

/**
 * Resolve the operator-saved exact Devin model live from deployment config.
 * Returns `undefined` when no deployment default is saved (explicit
 * no-selection) or the config file is absent. Never falls back to another
 * model and never consults the startup snapshot.
 */
export function resolveDeploymentDevinModel(goblinHome: string): string | undefined {
  try {
    const settings = readDeploymentSettings(goblinHome);
    return settings.devinDefaultModel ?? undefined;
  } catch (err) {
    if (err instanceof SettingsStoreError && err.reason === "missing-config") return undefined;
    throw err;
  }
}

/**
 * Build the `resolveDevinModel` closure the delegated external-agent tool
 * expects. The closure reads live on every admission so saves apply to the
 * next run without a restart; concurrent admissions read independently.
 */
export function createDeploymentDevinModelResolver(goblinHome: string): () => string | undefined {
  return () => resolveDeploymentDevinModel(goblinHome);
}
