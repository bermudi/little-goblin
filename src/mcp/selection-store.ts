/**
 * Deployment MCP selection store — the sole writer of the `mcp` section in
 * `goblin.json5`.
 *
 * Owner: McpSelectionStore (this module).
 * Lifetime: deployment (process config, survives restarts via goblin.json5).
 * Authority: `goblin.json5` `mcp` section. `loadConfig()` remains the reader;
 * this module is the only writer. Commands never touch the file directly —
 * they call `setMcpServerEnabled()` here.
 * Persistence: `$GOBLIN_HOME/goblin.json5` via the shared
 * `updateGoblinConfig()` coordination (one lock, one compare-and-swap, one
 * mode-preserving durable write shared with the Settings store).
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

/**
 * Enable or disable one mcporter server in goblin.json5 and persist the file.
 *
 * Only mutates the `mcp` section; all other top-level keys (including
 * credentials and the Settings-owned `devin` section) are preserved by the
 * shared coordinated writer. The service still requires a restart for tool
 * registration changes; the caller refreshes the in-memory catalog for
 * immediate visibility.
 */
export function setMcpServerEnabled(
  goblinHome: string,
  server: string,
  enabled: boolean,
): { config: McpConfig; path: string } {
  const path = goblinConfigPath(goblinHome);
  let next: Record<string, unknown> = {};
  updateGoblinConfig(goblinHome, raw => {
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
  });
  return { config: validateMcpSection(next), path };
}
