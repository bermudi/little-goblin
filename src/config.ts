import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { ConfigFileSchema } from "./schema.ts";
import { resolveConfigValue } from "./resolve-value.ts";

export interface Config {
  botToken: string;
  allowedTgUserIds: Set<number>;
  /** Model id — must be a key in `MODELS` (see src/agent/models.ts). */
  modelName: string;
  /** Poe API key. Required iff selected model uses it. */
  poeApiKey?: string;
  /** OpenRouter API key. Required iff selected model uses it. */
  openrouterApiKey?: string;
  /** OpenAI API key. Required iff selected model uses it. */
  openaiApiKey?: string;
  /** Anthropic API key. Required iff selected model uses it. */
  anthropicApiKey?: string;
  goblinHome: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Status-line tool visibility level. See `src/tg/buffer.ts`. */
  toolVisibility: "none" | "minimal" | "standard" | "verbose" | "debug";
  skillSources: "goblin-only" | "user" | "auto";
  /** Favorite model ids for /model switching. */
  favorites: string[];
}

/**
 * Load and validate configuration from goblin.json5.
 * Resolution order:
 *   1. GOBLIN_HOME env var -> use as directory
 *   2. Default: ~/goblin
 *
 * Config file is read from $GOBLIN_HOME/goblin.json5.
 * All string values are resolved via resolveConfigValue() before validation.
 */
export function loadConfig(): Config {
  // Resolve goblinHome first (not from config file, but from env/default)
  const goblinHome = process.env.GOBLIN_HOME ?? join(homedir(), "goblin");
  const configPath = join(goblinHome, "goblin.json5");

  // Read and parse config file
  let raw: unknown;
  try {
    const content = readFileSync(configPath, "utf-8");
    raw = JSON5.parse(content);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw new Error(`Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve all string values in the raw config object
  const resolved = resolveAllStrings(raw as Record<string, unknown>);

  // Validate with Zod
  const parsed = ConfigFileSchema.safeParse(resolved);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Config validation failed: ${issues}`);
  }
  const cfg = parsed.data;

  // Build frozen Config object
  const config: Config = Object.freeze({
    botToken: cfg.botToken,
    allowedTgUserIds: new Set(cfg.allowedUsers),
    modelName: cfg.model,
    poeApiKey: cfg.poeApiKey,
    openrouterApiKey: cfg.openrouterApiKey,
    openaiApiKey: cfg.openaiApiKey,
    anthropicApiKey: cfg.anthropicApiKey,
    goblinHome,
    logLevel: cfg.logLevel,
    toolVisibility: cfg.toolVisibility,
    skillSources: cfg.skillSources,
    favorites: cfg.favorites ?? [],
  });

  return config;
}

/**
 * Recursively resolve all string values in an object using resolveConfigValue().
 * Handles arrays and nested objects, but ConfigFileSchema has a flat shape.
 */
function resolveAllStrings(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveValue(value);
  }
  return result;
}

/**
 * Resolve a single value: strings get resolved, arrays get their strings resolved,
 * other values pass through.
 */
function resolveValue(value: unknown): unknown {
  if (typeof value === "string") {
    return resolveConfigValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? resolveConfigValue(v) : v));
  }
  return value;
}

/**
 * Ensure GOBLIN_HOME directory exists with required subdirectories.
 * Call once at startup before any consumer tries to use the paths.
 */
export function ensureGoblinHome(cfg: Config): void {
  // Migrate legacy pi-agent/ → goblin/ (one-time rename).
  const legacyDir = join(cfg.goblinHome, "pi-agent");
  const newDir = join(cfg.goblinHome, "goblin");
  if (existsSync(legacyDir) && !existsSync(newDir)) {
    renameSync(legacyDir, newDir);
  }

  const dirs = [cfg.goblinHome, join(cfg.goblinHome, "sessions"), join(cfg.goblinHome, "skills"), join(cfg.goblinHome, "workdir"), newDir, join(cfg.goblinHome, "agents"), join(cfg.goblinHome, "subagents")];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
