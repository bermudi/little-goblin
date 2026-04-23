import { execSync } from "node:child_process";

const commandCache = new Map<string, string>();

/**
 * Resolve a config value using pi-style three-way resolution:
 * 1. "!command" -> execute shell command, cache output for process lifetime
 * 2. env var name -> use process.env value if it exists
 * 3. literal -> use the string as-is
 *
 * Returns undefined for failed commands.
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

  // 3. Literal value
  return value;
}

/** Clear the command cache. Used for testing. */
export function clearResolveCache(): void {
  commandCache.clear();
}
