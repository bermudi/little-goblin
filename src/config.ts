import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Env loading strategy:
 *   - Bun auto-loads `.env` from cwd (dev workflow)
 *   - For prod installs (XDG paths), use: bun --env-file=$GOBLIN_ENV_FILE ...
 *     or set GOBLIN_ENV_FILE and run from that directory
 *
 * Bun's built-in parser handles exports, quotes, and multi-line values correctly.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function parseIdList(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`ALLOWED_TG_USER_IDS: "${s}" is not an integer`);
      return n;
    });
  if (ids.length === 0) throw new Error("ALLOWED_TG_USER_IDS must contain at least one id");
  return new Set(ids);
}

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
}

export function loadConfig(): Config {
  const goblinHome = optional("GOBLIN_HOME", join(homedir(), "goblin"));
  const poeApiKey = process.env.POE_API_KEY || undefined;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY || undefined;
  const openaiApiKey = process.env.OPENAI_API_KEY || undefined;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || undefined;
  return {
    botToken: required("BOT_TOKEN"),
    allowedTgUserIds: parseIdList(required("ALLOWED_TG_USER_IDS")),
    modelName: required("MODEL_NAME"),
    poeApiKey,
    openrouterApiKey,
    openaiApiKey,
    anthropicApiKey,
    goblinHome,
  };
}

/**
 * Ensure GOBLIN_HOME directory exists with required subdirectories.
 * Call once at startup before any consumer tries to use the paths.
 */
export function ensureGoblinHome(cfg: Config): void {
  const dirs = [cfg.goblinHome, join(cfg.goblinHome, "sessions"), join(cfg.goblinHome, "skills"), join(cfg.goblinHome, "workdir"), join(cfg.goblinHome, "pi-agent")];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
