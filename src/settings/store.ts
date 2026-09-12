/**
 * Deployment-config store — the sole writer of the whitelisted non-secret
 * sections of `goblin.json5`: `general` (whitelisted top-level fields),
 * `embeddings` (minus its key), `externalAgents.backends`, `devin`, and
 * `settings`.
 *
 * Owner: Settings store (this module).
 * Lifetime: deployment (process config, survives restarts via goblin.json5).
 * Authority: `goblin.json5`. Reads hit the file every time so no stale
 * startup snapshot can become the live authority. Writes go through the
 * shared `updateGoblinConfig()` coordination so MCP and Settings mutations
 * share one lock, one compare-and-swap, and one mode-preserving durable
 * write; only the target section's whitelisted keys are mutated, and the
 * merged file must pass boot-equivalent validation (`validateBootConfig`,
 * src/config.ts) before commit: strings are resolved the way `loadConfig`
 * resolves them (set env names from the live process environment, the same
 * environment boot uses) and the resolved tree must satisfy
 * `ConfigFileSchema`, so a raw-valid but unbootable change — e.g. an
 * env-style literal like `model: "GPT4TURBO"` that resolves to undefined —
 * is never written. The one deliberate gap: `!command` values are never
 * executed outside boot, so the guard validates them as literal strings;
 * boot itself resolves them (see `validateBootConfig`). The `mcp` section is
 * never written here — McpSelectionStore owns it (decision 0042); it is
 * surfaced in the read projection only, sourced through that store's
 * `projectMcpSelection`.
 * `externalAgents.devinModel` is never surfaced or written;
 * `devin.defaultModel` is the only Devin model knob (decision 0049).
 * Persistence: `$GOBLIN_HOME/goblin.json5`.
 * Secrets (bot token, provider API keys, `embeddings.apiKey`) never leave
 * this module as values: read projections carry `{present: boolean}`
 * presence flags only, and secret write targets are rejected with an
 * actionable error before any filesystem effect.
 */

import JSON5 from "json5";
import { projectMcpSelection, type McpSelectionProjection } from "../mcp/selection-store.ts";
import { readGoblinConfigText, revisionForConfigText, updateGoblinConfig } from "../goblin-config-file.ts";
import { validateBootConfig } from "../config.ts";
import { ExternalAgentsConfigSchema, SettingsConfigSchema } from "../schema.ts";

/** Presence flag for a secret field; the value never leaves the store. */
export interface SecretPresence {
  present: boolean;
}

export interface GeneralConfigProjection {
  model: string;
  logLevel: string;
  toolVisibility: string;
  voiceName: string;
  asrModel: string;
  favorites: string[];
  allowedUsers: number[];
}

export interface EmbeddingsConfigProjection {
  baseUrl?: string;
  model?: string;
  provider?: string;
  cooldownSeconds?: number;
  /** `embeddings.apiKey` is a secret; surfaced as presence only. */
  apiKey: SecretPresence;
}

export interface ExternalAgentsConfigProjection {
  backends: string[];
}

export interface DevinConfigProjection {
  /** Exact saved Devin model id, or null when no deployment default is set. */
  defaultModel: string | null;
}

export interface SettingsConfigProjection {
  enabled: boolean;
  port: number;
  publicUrl?: string;
  allowedOrigins: string[];
}

export interface DeploymentSecretsProjection {
  botToken: SecretPresence;
  openrouterApiKey: SecretPresence;
  openaiApiKey: SecretPresence;
  anthropicApiKey: SecretPresence;
  zaiApiKey: SecretPresence;
  opencodeApiKey: SecretPresence;
  groqApiKey: SecretPresence;
}

/** Full non-secret projection of the deployment config plus its revision. */
export interface DeploymentConfig {
  general: GeneralConfigProjection;
  embeddings: EmbeddingsConfigProjection;
  "external-agents": ExternalAgentsConfigProjection;
  devin: DevinConfigProjection;
  settings: SettingsConfigProjection;
  /** Read-only projection of the mcp section; writes live in McpSelectionStore (decision 0042). */
  mcp: McpSelectionProjection;
  secrets: DeploymentSecretsProjection;
  /** Content revision for stale-write detection; changes on any file edit. */
  revision: string;
}

export interface DeploymentSettings {
  /** Exact saved Devin model id, or null when no deployment default is set. */
  devinDefaultModel: string | null;
  /** Content revision for stale-write detection; changes on any file edit. */
  revision: string;
}

export type SettingsStoreReason =
  | "stale-revision"
  | "conflict"
  | "missing-config"
  | "unknown-section"
  | "unknown-field"
  | "secret-field"
  | "invalid-patch"
  | "invalid-config";

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

/** Whitelisted writable fields per section; `general` fields live top-level. */
const SECTION_WRITABLE_KEYS = {
  general: ["model", "logLevel", "toolVisibility", "voiceName", "asrModel", "favorites", "allowedUsers"],
  embeddings: ["baseUrl", "model", "provider", "cooldownSeconds"],
  "external-agents": ["backends"],
  devin: ["defaultModel"],
  settings: ["enabled", "port", "publicUrl", "allowedOrigins"],
} as const;

export type ConfigSectionName = keyof typeof SECTION_WRITABLE_KEYS;

/** File-level key for each section; `general` maps to the top level. */
const SECTION_FILE_KEYS: Record<ConfigSectionName, string | null> = {
  general: null,
  embeddings: "embeddings",
  "external-agents": "externalAgents",
  devin: "devin",
  settings: "settings",
};

/** Secret config fields; never projected as values, never writable. */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "botToken",
  "openrouterApiKey",
  "openaiApiKey",
  "anthropicApiKey",
  "zaiApiKey",
  "opencodeApiKey",
  "groqApiKey",
]);

// Schema-derived defaults keep the projection in sync with the config
// schema when a section is absent from the file.
const DEFAULT_SETTINGS_SECTION: SettingsConfigProjection = (() => {
  const parsed = SettingsConfigSchema.parse({});
  return {
    enabled: parsed.enabled,
    port: parsed.port,
    publicUrl: parsed.publicUrl,
    allowedOrigins: parsed.allowedOrigins ?? [],
  };
})();
const DEFAULT_EXTERNAL_BACKENDS: string[] = ExternalAgentsConfigSchema.parse({}).backends;

function isConfigSectionName(value: unknown): value is ConfigSectionName {
  return typeof value === "string" && Object.hasOwn(SECTION_WRITABLE_KEYS, value);
}

function readConfigTextOrMissing(goblinHome: string): string {
  try {
    return readGoblinConfigText(goblinHome);
  } catch (err) {
    if (err instanceof Error && /Config file not found/.test(err.message)) {
      throw new SettingsStoreError("missing-config", err.message);
    }
    throw err;
  }
}

/**
 * Read the full non-secret deployment-config projection. Schema defaults
 * fill fields absent from the file; secret fields appear only as presence
 * flags. Fails loud (missing-config is the one mapped ENOENT case); a file
 * that fails boot validation — the resolved-tree check boot applies — is
 * rejected as `invalid-config` because it would not boot.
 */
export function readDeploymentConfig(goblinHome: string): DeploymentConfig {
  const text = readConfigTextOrMissing(goblinHome);
  const raw: unknown = JSON5.parse(text);
  const boot = validateBootConfig(raw);
  if (!boot.bootable) {
    throw new SettingsStoreError(
      "invalid-config",
      `Config file fails boot validation (it would not boot): ${boot.issues}`,
    );
  }
  const data = boot.config!;
  const settings = data.settings ?? DEFAULT_SETTINGS_SECTION;
  return {
    general: {
      model: data.model,
      logLevel: data.logLevel,
      toolVisibility: data.toolVisibility,
      voiceName: data.voiceName,
      asrModel: data.asrModel,
      favorites: data.favorites ?? [],
      allowedUsers: data.allowedUsers,
    },
    embeddings: {
      baseUrl: data.embeddings?.baseUrl,
      model: data.embeddings?.model,
      provider: data.embeddings?.provider,
      cooldownSeconds: data.embeddings?.cooldownSeconds,
      apiKey: { present: data.embeddings?.apiKey !== undefined },
    },
    "external-agents": { backends: data.externalAgents?.backends ?? DEFAULT_EXTERNAL_BACKENDS },
    devin: { defaultModel: data.devin?.defaultModel ?? null },
    settings: {
      enabled: settings.enabled,
      port: settings.port,
      publicUrl: settings.publicUrl,
      allowedOrigins: settings.allowedOrigins ?? [],
    },
    mcp: projectMcpSelection(data.mcp),
    secrets: {
      botToken: { present: true },
      openrouterApiKey: { present: data.openrouterApiKey !== undefined },
      openaiApiKey: { present: data.openaiApiKey !== undefined },
      anthropicApiKey: { present: data.anthropicApiKey !== undefined },
      zaiApiKey: { present: data.zaiApiKey !== undefined },
      opencodeApiKey: { present: data.opencodeApiKey !== undefined },
      groqApiKey: { present: data.groqApiKey !== undefined },
    },
    revision: revisionForConfigText(text),
  };
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
 * Reject non-whitelisted, secret, and legacy-snapshot patch targets before
 * any filesystem effect. Messages name the field and never echo values.
 */
function assertWritablePatch(section: ConfigSectionName, patch: Record<string, unknown>): void {
  const writable = SECTION_WRITABLE_KEYS[section] as readonly string[];
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) {
      throw new SettingsStoreError(
        "invalid-patch",
        `Field "${key}" in section "${section}" must have a value; undefined is not a writable value.`,
      );
    }
    if (section === "embeddings" && key === "apiKey") {
      throw new SettingsStoreError(
        "secret-field",
        "embeddings.apiKey is a secret field and is never writable through the deployment-config store; edit goblin.json5 or its env/command source directly.",
      );
    }
    if (section === "general" && SECRET_FIELD_NAMES.has(key)) {
      throw new SettingsStoreError(
        "secret-field",
        `"${key}" is a secret field and is never writable through the deployment-config store; edit goblin.json5 or its env/command source directly.`,
      );
    }
    if (section === "external-agents" && key === "devinModel") {
      throw new SettingsStoreError(
        "unknown-field",
        'externalAgents.devinModel is never written through settings; "devin.defaultModel" is the only Devin model knob (decision 0049).',
      );
    }
    if (!writable.includes(key)) {
      throw new SettingsStoreError(
        "unknown-field",
        `Unknown field "${key}" for section "${section}"; writable fields: ${writable.join(", ")}.`,
      );
    }
  }
}

/** Merge the patch onto the section, preserving unrelated keys. */
function applySectionPatch(
  raw: Record<string, unknown>,
  section: ConfigSectionName,
  patch: Record<string, unknown>,
): void {
  const fileKey = SECTION_FILE_KEYS[section];
  if (fileKey === null) {
    for (const [key, value] of Object.entries(patch)) {
      raw[key] = value;
    }
    return;
  }
  const existing = raw[fileKey];
  const base =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    base[key] = value;
  }
  raw[fileKey] = base;
}

export interface ConfigSectionSaveOptions {
  /** Revision from a prior read; a stale value rejects the write. */
  expectedRevision?: string;
}

export interface ConfigSectionSaveResult {
  /** Content revision of the committed file. */
  revision: string;
}

/**
 * Save one section's whitelisted fields. Unknown sections, secret targets,
 * and unknown fields are rejected before any filesystem effect; a patch
 * whose merged file would fail boot validation (`validateBootConfig`:
 * boot-equivalent string resolution plus the full config schema) is
 * rejected before commit, so a config that would not boot is never
 * written. Unrelated keys and the file mode are preserved by the shared
 * coordinated writer. `expectedRevision` (from a prior read) rejects stale
 * writes so concurrent MCP and Settings edits are never clobbered.
 */
export function saveConfigSection(
  goblinHome: string,
  section: string,
  patch: unknown,
  options?: ConfigSectionSaveOptions,
): ConfigSectionSaveResult {
  if (!isConfigSectionName(section)) {
    const known = Object.keys(SECTION_WRITABLE_KEYS).join(", ");
    const mcpNote = section === "mcp" ? " The mcp section is owned by McpSelectionStore (decision 0042)." : "";
    throw new SettingsStoreError(
      "unknown-section",
      `Unknown config section ${JSON.stringify(section)}; writable sections: ${known}.${mcpNote}`,
    );
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SettingsStoreError("invalid-patch", `Section patch for "${section}" must be an object of field values.`);
  }
  const fields = patch as Record<string, unknown>;
  assertWritablePatch(section, fields);
  try {
    const { revision } = updateGoblinConfig(
      goblinHome,
      (raw) => {
        applySectionPatch(raw, section, fields);
        // Never write a file that would not boot: validate the merged
        // result the way boot would (resolved strings, full schema) before
        // committing.
        const boot = validateBootConfig(raw);
        if (!boot.bootable) {
          throw new SettingsStoreError(
            "invalid-config",
            `Config update rejected: the change would not boot (resolved config fails validation): ${boot.issues}`,
          );
        }
      },
      { expectedRevision: options?.expectedRevision },
    );
    return { revision };
  } catch (err: unknown) {
    throw toStoreError(err);
  }
}

/**
 * Legacy one-knob read view over the deployment-config store: only the Devin
 * deployment default plus the revision. Writes go through `saveConfigSection`.
 */
export function readDeploymentSettings(goblinHome: string): DeploymentSettings {
  const config = readDeploymentConfig(goblinHome);
  return { devinDefaultModel: config.devin.defaultModel, revision: config.revision };
}
