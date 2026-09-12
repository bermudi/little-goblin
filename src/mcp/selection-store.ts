/**
 * Deployment MCP selection store — the sole writer of the `mcp` section in
 * `goblin.json5`.
 *
 * Owner: McpSelectionStore (this module).
 * Lifetime: deployment (process config, survives restarts via goblin.json5).
 * Authority: `goblin.json5` `mcp` section. `loadConfig()` remains the reader;
 * this module is the only writer. Commands and the Settings API never touch
 * the file directly — they call `setMcpServerEnabled()` / `setMcpLimits()`
 * here (Settings routes `PUT /api/config/mcp` through this store, decision
 * 0042).
 * Persistence: `$GOBLIN_HOME/goblin.json5` via the shared
 * `updateGoblinConfig()` coordination (one lock, one compare-and-swap, one
 * mode-preserving durable write shared with the Settings store).
 *
 * Every mutation accepts an `expectedRevision` (the content revision from a
 * prior read) and participates in the same compare-and-swap as every other
 * config writer, so concurrent Settings and MCP edits can never clobber each
 * other and return the new revision. Reads project through `projectMcpSelection`
 * (lists + limits + `configPath` presence only — the path value never leaves
 * the store projection).
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

import { McpConfigSchema, type McpConfig } from "../schema.ts";
import { goblinConfigPath } from "../sessions/paths.ts";
import { updateGoblinConfig } from "../goblin-config-file.ts";

export type McpSelectionErrorReason = "invalid-section" | "invalid-limits";

/** Actionable MCP-section failure; filesystem IO errors other than ENOENT propagate unwrapped. */
export class McpSelectionStoreError extends Error {
  constructor(
    readonly reason: McpSelectionErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "McpSelectionStoreError";
  }
}

/**
 * Validate an mcp section against the config schema. Returns the parsed
 * McpConfig (with schema defaults applied) or throws McpSelectionStoreError
 * ("invalid-section") with a compact message.
 */
export function validateMcpSection(value: unknown): McpConfig {
  const parsed = McpConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new McpSelectionStoreError("invalid-section", `mcp config validation failed: ${issues}`);
  }
  return parsed.data;
}

/** Read-only UI projection of the mcp section; never a write target. */
export interface McpSelectionProjection {
  /** Positive allow-list; null = no allow-list (every gateway server is on). */
  enabled: string[] | null;
  disabledServers: string[];
  defaultTimeoutMs: number;
  maxResultChars: number;
  /** `configPath` is operator-owned; surfaced as presence only, never a value. */
  configPath: { present: boolean };
}

/**
 * Project the mcp section (undefined when absent from the file) for read
 * surfaces such as the Settings API. Values come from the validated config,
 * so schema defaults are applied; `configPath` appears only as a presence
 * flag.
 */
export function projectMcpSelection(config: McpConfig | undefined): McpSelectionProjection {
  const resolved = config ?? validateMcpSection({});
  return {
    enabled: resolved.enabled ?? null,
    disabledServers: resolved.disabledServers ?? [],
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    maxResultChars: resolved.maxResultChars,
    configPath: { present: resolved.configPath !== undefined },
  };
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

export interface McpMutationOptions {
  /** Revision from a prior read; a stale value rejects the write (shared CAS). */
  expectedRevision?: string;
}

export interface McpMutationResult {
  config: McpConfig;
  path: string;
  /** Content revision of the committed file. */
  revision: string;
}

/**
 * Enable or disable one mcporter server in goblin.json5 and persist the file.
 *
 * Only mutates the `mcp` section; all other top-level keys (including
 * credentials and the Settings-owned `devin` section) are preserved by the
 * shared coordinated writer. `expectedRevision` (from a prior read) rejects
 * stale writes so concurrent MCP and Settings edits are never clobbered. The
 * service still requires a restart for tool registration changes; the caller
 * refreshes the in-memory catalog for immediate visibility.
 */
export function setMcpServerEnabled(
  goblinHome: string,
  server: string,
  enabled: boolean,
  options?: McpMutationOptions,
): McpMutationResult {
  const path = goblinConfigPath(goblinHome);
  let next: Record<string, unknown> = {};
  const { revision } = updateGoblinConfig(
    goblinHome,
    (raw) => {
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

      next = { ...section };
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
    },
    { expectedRevision: options?.expectedRevision },
  );
  return { config: validateMcpSection(next), path, revision };
}

const MCP_LIMIT_KEYS = ["defaultTimeoutMs", "maxResultChars"] as const;

export interface McpLimitsPatch {
  defaultTimeoutMs?: number;
  maxResultChars?: number;
}

/**
 * Validate an mcp limits patch against the config schema (the range
 * authority for both fields). Returns only the provided keys, so a limits
 * write never materializes schema defaults into the file. Throws
 * McpSelectionStoreError ("invalid-limits") with a compact message before
 * any filesystem effect.
 */
export function validateMcpLimits(patch: unknown): McpLimitsPatch {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new McpSelectionStoreError(
      "invalid-limits",
      "MCP limits patch must be an object with optional defaultTimeoutMs and maxResultChars.",
    );
  }
  const raw = patch as Record<string, unknown>;
  const out: McpLimitsPatch = {};
  for (const key of MCP_LIMIT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    const check = McpConfigSchema.shape[key].safeParse(value);
    if (!check.success) {
      const issues = check.error.issues.map((i) => i.message).join("; ");
      throw new McpSelectionStoreError("invalid-limits", `mcp limits validation failed: ${key}: ${issues}`);
    }
    out[key] = check.data;
  }
  const unknown = Object.keys(raw).filter((key) => !(MCP_LIMIT_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new McpSelectionStoreError(
      "invalid-limits",
      `Unknown MCP limit field(s): ${unknown.join(", ")}; writable limits: ${MCP_LIMIT_KEYS.join(", ")}.`,
    );
  }
  return out;
}

/**
 * Update the mcp section's `defaultTimeoutMs` / `maxResultChars` limits in
 * goblin.json5 and persist the file.
 *
 * Only mutates the `mcp` section's limit keys; lists, `configPath`, and all
 * other top-level keys are preserved by the shared coordinated writer, and
 * `expectedRevision` (from a prior read) rejects stale writes. A section that
 * already fails validation is refused rather than silently rewritten.
 */
export function setMcpLimits(
  goblinHome: string,
  limits: McpLimitsPatch,
  options?: McpMutationOptions,
): McpMutationResult {
  // Validate before any filesystem effect so invalid limits never touch disk.
  const applied = validateMcpLimits(limits);
  const path = goblinConfigPath(goblinHome);
  let next: Record<string, unknown> = {};
  const { revision } = updateGoblinConfig(
    goblinHome,
    (raw) => {
      const section = (raw.mcp ?? {}) as Record<string, unknown>;
      // Refuse to mutate a section that already fails validation.
      validateMcpSection(section);
      next = { ...section };
      if (applied.defaultTimeoutMs !== undefined) next.defaultTimeoutMs = applied.defaultTimeoutMs;
      if (applied.maxResultChars !== undefined) next.maxResultChars = applied.maxResultChars;
      raw.mcp = next;
      // Re-validate the merged section so a bad write can never persist.
      validateMcpSection(next);
    },
    { expectedRevision: options?.expectedRevision },
  );
  return { config: validateMcpSection(next), path, revision };
}
