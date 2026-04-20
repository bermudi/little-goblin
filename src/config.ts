import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Load env from the first file that exists, in priority order:
 *   1. $GOBLIN_ENV_FILE            (explicit override)
 *   2. $XDG_CONFIG_HOME/goblin/.env  (prod install)
 *   3. ~/.config/goblin/.env         (prod install, fallback)
 *   4. ./.env                        (dev, run from repo)
 *
 * Bun auto-loads `.env` from cwd, so (4) is already handled. We handle (1)-(3).
 */
function loadEnvFile(): void {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const candidates = [
    process.env.GOBLIN_ENV_FILE,
    xdg ? join(xdg, "goblin", ".env") : undefined,
    join(home, ".config", "goblin", ".env"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    if (existsSync(path)) {
      // Minimal .env parser, synchronous. KEY=VALUE per line, # comments, blanks ignored.
      // Not overriding existing env vars (they win).
      const contents = readFileSync(path, "utf8");
      for (const raw of contents.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
  }
}

loadEnvFile();

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
  modelBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  goblinHome: string;
}

export function loadConfig(): Config {
  const goblinHome = optional("GOBLIN_HOME", join(homedir(), "goblin"));
  return {
    botToken: required("BOT_TOKEN"),
    allowedTgUserIds: parseIdList(required("ALLOWED_TG_USER_IDS")),
    modelBaseUrl: required("MODEL_BASE_URL"),
    modelApiKey: required("MODEL_API_KEY"),
    modelName: required("MODEL_NAME"),
    goblinHome,
  };
}
