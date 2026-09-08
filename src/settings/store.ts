/**
 * Durable deployment settings store — the sole writer of the `devin` section
 * in `goblin.json5`.
 *
 * Owner: Settings store (this module).
 * Lifetime: deployment (process config, survives restarts via goblin.json5).
 * Authority: `goblin.json5` `devin.defaultModel`. No second durable copy and
 * no in-memory published value: reads hit the file every time so a stale
 * startup snapshot can never become the live authority. Writes go through
 * the shared `updateGoblinConfig()` coordination so MCP and Settings
 * mutations share one lock, one compare-and-swap, and one mode-preserving
 * durable write; only the `devin` section is mutated.
 * Persistence: `$GOBLIN_HOME/goblin.json5` (`devin: { defaultModel }`).
 * Absent section means explicit no-selection (null).
 */

import JSON5 from "json5";
import { readGoblinConfigText, revisionForConfigText, updateGoblinConfig } from "../goblin-config-file.ts";
import type { DevinModelCatalog } from "./devin-catalog.ts";

export interface DeploymentSettings {
  /** Exact saved Devin model id, or null when no deployment default is set. */
  devinDefaultModel: string | null;
  /** Content revision for stale-write detection; changes on any file edit. */
  revision: string;
}

export type SettingsStoreReason = "invalid-selection" | "stale-revision" | "conflict" | "missing-config";

/** Actionable failure; filesystem IO errors other than ENOENT propagate unwrapped. */
export class SettingsStoreError extends Error {
  constructor(
    readonly reason: SettingsStoreReason,
    message: string,
  ) {
    super(message);
    this.name = "SettingsStoreError";
  }
}

function isValidModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function readSelection(raw: Record<string, unknown>): string | null {
  const section = raw.devin;
  if (section === undefined) return null;
  if (section === null || typeof section !== "object" || Array.isArray(section)) return null;
  const model = (section as Record<string, unknown>).defaultModel;
  return isValidModelId(model) ? model : null;
}

/**
 * Read the non-secret deployment settings projection. Returns only the
 * supported deployment default plus a revision; never credentials or the
 * full configuration.
 */
export function readDeploymentSettings(goblinHome: string): DeploymentSettings {
  let text: string;
  try {
    text = readGoblinConfigText(goblinHome);
  } catch (err) {
    if (err instanceof Error && /Config file not found/.test(err.message)) {
      throw new SettingsStoreError("missing-config", err.message);
    }
    throw err;
  }
  const raw = JSON5.parse(text) as Record<string, unknown>;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SettingsStoreError("invalid-selection", "Config file does not contain a top-level object");
  }
  return { devinDefaultModel: readSelection(raw), revision: revisionForConfigText(text) };
}

function toStoreError(err: unknown): unknown {
  if (err instanceof SettingsStoreError) return err;
  if (err instanceof Error) {
    if (/Config file not found/.test(err.message)) return new SettingsStoreError("missing-config", err.message);
    if (/stale revision/.test(err.message)) return new SettingsStoreError("stale-revision", err.message);
    if (/changed during update|Config is locked/.test(err.message)) {
      return new SettingsStoreError("conflict", err.message);
    }
  }
  return err;
}

/**
 * Save one exact Devin model as the deployment default. `modelId` must be a
 * non-empty unpadded id; when `catalog` is supplied it must contain the id.
 * `expectedRevision` (from a prior read) rejects stale writes so a
 * concurrent MCP edit is never clobbered. The new value is published only
 * after the durable commit; failures leave the last committed selection
 * intact. Unrelated config keys and the file mode are preserved by the
 * shared coordinated writer.
 */
export function saveDeploymentModel(
  goblinHome: string,
  modelId: string,
  options?: { expectedRevision?: string; catalog?: DevinModelCatalog },
): DeploymentSettings {
  if (!isValidModelId(modelId)) {
    throw new SettingsStoreError("invalid-selection", `Invalid Devin model selection: ${JSON.stringify(modelId)}`);
  }
  if (options?.catalog !== undefined) {
    const known = options.catalog.families.some(family => family.variants.some(variant => variant.id === modelId));
    if (!known) {
      throw new SettingsStoreError("invalid-selection", `Unknown Devin model selection: ${JSON.stringify(modelId)}`);
    }
  }
  try {
    const { revision } = updateGoblinConfig(
      goblinHome,
      raw => {
        const section =
          raw.devin !== null && typeof raw.devin === "object" && !Array.isArray(raw.devin)
            ? { ...(raw.devin as Record<string, unknown>) }
            : {};
        section.defaultModel = modelId;
        raw.devin = section;
      },
      { expectedRevision: options?.expectedRevision },
    );
    return { devinDefaultModel: modelId, revision };
  } catch (err: unknown) {
    throw toStoreError(err);
  }
}
