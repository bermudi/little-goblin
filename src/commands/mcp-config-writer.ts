import { existsSync, readFileSync } from "node:fs";
import JSON5 from "json5";
import { McpConfigSchema, type McpConfig } from "../schema.ts";
import { goblinConfigPath } from "../sessions/paths.ts";
import { atomicWrite } from "../fs.ts";

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
 * Enable or disable one mcporter server in goblin.json5 and persist the file.
 *
 * Semantics:
 * - Creates the `mcp` section when absent (schema defaults for timeouts/caps).
 * - `enabled: undefined` means "everything in the mcporter config is on", so
 *   disabling the first server materializes the full current allow-list first.
 * - Re-enabling removes the server from a `disabled` list tracked alongside
 *   the allow-list (`mcp.disabledServers`), never re-adds it to `enabled`.
 * - Writes atomically (tmp + fsync + rename) and preserves all other config
 *   content, comments excluded (JSON5 round-trip).
 *
 * This is an operator-assistance writer: it only mutates the `mcp` section.
 * The service still requires a restart to pick up config changes.
 */
export function setMcpServerEnabled(goblinHome: string, server: string, enabled: boolean): { config: McpConfig; path: string } {
  const path = goblinConfigPath(goblinHome);
  const raw = JSON5.parse(readRawConfigText(goblinHome)) as Record<string, unknown>;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config file does not contain a top-level object");
  }

  const section = (raw.mcp ?? {}) as Record<string, unknown>;
  const current = validateMcpSection(section);

  // Current effective allow-list. `enabled: undefined` = all catalog servers
  // on, so the persisted list must start from the disabled complement.
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
  if (disabled.size > 0) next.disabledServers = [...disabled].sort();
  else delete next.disabledServers;

  // Drop an empty section rather than persisting `mcp: {}`.
  if (Object.keys(next).length === 0) delete raw.mcp;
  else raw.mcp = next;

  // Re-validate the merged file section so a bad write can never persist.
  validateMcpSection(next);

  atomicWrite(path, JSON5.stringify(raw, { space: 2 }) + "\n");
  return { config: validateMcpSection(next), path };
}
