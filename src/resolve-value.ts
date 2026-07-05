import { execSync } from "node:child_process";

const commandCache = new Map<string, string>();

/**
 * Resolve a config value using four-way resolution:
 * 1. "!command" -> execute shell command, cache output for process lifetime
 * 2. env var name that is set -> use process.env value
 * 3. env-style name (ASCII upper-snake) that is NOT set -> undefined
 *    (so unresolved `groqApiKey: "GROQ_API_KEY"` doesn't leak the literal)
 * 4. any other literal -> use the string as-is
 *
 * Returns undefined for failed commands and unresolved env-style names.
 */
export function resolveConfigValue(value: string): string | undefined {
  // 1. Command execution: starts with !
  if (value.startsWith("!")) {
    const cmd = value.slice(1).trim();
    const cached = commandCache.get(cmd);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
      const trimmed = output.trim();
      commandCache.set(cmd, trimmed);
      return trimmed;
    } catch {
      return undefined;
    }
  }

  // 2. Env var lookup: if string matches an env var name exactly
  if (value in process.env && process.env[value] !== undefined) {
    return process.env[value];
  }

  // 3. Unresolved env-style name: a value that looks like an env var name
  //    (matches /^[A-Z][A-Z0-9_]*$/) but is not set resolves to undefined.
  //    Without this, an unresolved `groqApiKey: "GROQ_API_KEY"` would leak the
  //    literal string into Config, defeating optional-key checks. Literal
  //    values that don't look like env names (tokens, model ids with lowercase
  //    or symbols) fall through unchanged.
  if (isEnvStyleName(value)) {
    return undefined;
  }

  // 4. Literal value
  return value;
}

/** A string that looks like an env-var name: ASCII upper-snake, length > 1. */
function isEnvStyleName(value: string): boolean {
  return value.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(value);
}

/** Clear the command cache. Used for testing. */
export function clearResolveCache(): void {
  commandCache.clear();
}
