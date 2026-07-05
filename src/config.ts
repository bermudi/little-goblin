import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { ConfigFileSchema } from "./schema.ts";
import { resolveConfigValue } from "./resolve-value.ts";
import { log } from "./log.ts";
import { configPath, schedulesPath, sessionsDir, topicSettingsPath } from "./sessions/paths.ts";
import { agentsMdPath, piAgentDir, skillsPath, soulMdPath, workdirPath } from "./pi-host.ts";
import { memoryDir } from "./memory/paths.ts";
import { namedAgentsRoot, subagentsRoot } from "./subagents/paths.ts";

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
  /** Z.AI Coding Plan API key. Required iff selected model uses it. */
  zaiApiKey?: string;
  /** OpenCode Go subscription API key. Required iff selected model uses it. */
  opencodeApiKey?: string;
  goblinHome: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Status-line tool visibility level. See `src/tg/buffer.ts`. */
  toolVisibility: "none" | "minimal" | "standard" | "verbose" | "debug";
  skillSources: "goblin-only" | "user";
  /** Favorite model ids for /model switching. */
  favorites: string[];
  /** Microsoft Edge TTS voice for /voice and text_to_speech. */
  voiceName: string;
  /** Groq API key for voice-note ASR. Undefined when not configured. */
  groqApiKey?: string;
  /**
   * Groq Whisper model for voice-note ASR. Optional on the interface so
   * hand-built test fixtures stay valid; `loadConfig` always populates it from
   * the schema default (`whisper-large-v3-turbo`).
   */
  asrModel?: "whisper-large-v3-turbo" | "whisper-large-v3";
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
  const goblinHome = process.env.GOBLIN_HOME ?? join(homedir(), ".goblin");
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
    zaiApiKey: cfg.zaiApiKey,
    opencodeApiKey: cfg.opencodeApiKey,
    goblinHome,
    logLevel: cfg.logLevel,
    toolVisibility: cfg.toolVisibility,
    skillSources: cfg.skillSources,
    favorites: cfg.favorites ?? [],
    voiceName: cfg.voiceName,
    groqApiKey: cfg.groqApiKey,
    asrModel: cfg.asrModel,
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
 *
 * Three phases, in order:
 *   1. Create the three top-level group directories (workspace/, state/,
 *      scratch/). Migration-target subdirectories are NOT created here —
 *      pre-creating them would make the "new path does not exist" guard skip
 *      every directory migration on legacy installs.
 *   2. Run the migration loop: for each legacy→new path pair, if the legacy
 *      path exists and the new path does not, `renameSync(old, new)`. If both
 *      exist, log a warning and skip (operator resolves). If a `renameSync`
 *      throws (e.g. cross-device), the error propagates and startup stops
 *      (fail loud, per AGENTS.md).
 *   3. Create remaining migration-target subdirectories that still don't
 *      exist (fresh install or legacy install where the legacy path was
 *      absent).
 *
 * Per decision `config-startup-filesystem-mutation` (0007), this function is
 * exempt from the AGENTS.md "Don't touch $GOBLIN_HOME" guardrail for
 * directory creation and migration `renameSync`. Per decision
 * `path-helper-only-path-construction` (0008), all path construction here goes
 * through the path-helper modules.
 */
export function ensureGoblinHome(cfg: Config): void {
  const home = cfg.goblinHome;

  // Phase 1: top-level group directories only. Do NOT create migration
  // targets (state/sessions, state/memory, state/pi, scratch/workdir, …)
  // before the migration loop runs.
  const groups = [
    home,
    join(home, "workspace"),
    join(home, "state"),
    join(home, "scratch"),
  ];
  for (const dir of groups) {
    mkdirSync(dir, { recursive: true });
  }

  // Phase 2: migrate legacy root-level paths to their new locations.
  // Order does not matter — every legacy path is at the home root and every
  // new path is under one of the three group dirs, so no pair aliases another.
  // The legacy pi-agent/ → goblin/ migration is superseded: pi-agent/ now
  // migrates directly to state/pi/, and a pre-existing goblin/ also migrates
  // to state/pi/ (whichever is present).
  const legacyPiAgent = join(home, "pi-agent");
  const legacyGoblin = join(home, "goblin");
  const migrations: Array<{ oldPath: string; newPath: string }> = [
    { oldPath: join(home, "sessions"), newPath: sessionsDir(home) },
    { oldPath: join(home, "config.json"), newPath: configPath(home) },
    { oldPath: join(home, "topic-settings.json"), newPath: topicSettingsPath(home) },
    { oldPath: join(home, "schedules.json"), newPath: schedulesPath(home) },
    { oldPath: join(home, "memory"), newPath: memoryDir(home) },
    { oldPath: legacyGoblin, newPath: piAgentDir(home) },
    { oldPath: legacyPiAgent, newPath: piAgentDir(home) },
    { oldPath: join(home, "workdir"), newPath: workdirPath(home) },
    { oldPath: join(home, "subagents"), newPath: subagentsRoot(home) },
    { oldPath: join(home, "agents"), newPath: namedAgentsRoot(home) },
    { oldPath: join(home, "skills"), newPath: skillsPath(home) },
    { oldPath: join(home, "SOUL.md"), newPath: soulMdPath(home) },
    { oldPath: join(home, "AGENTS.md"), newPath: agentsMdPath(home) },
  ];
  for (const { oldPath, newPath } of migrations) {
    if (!existsSync(oldPath)) continue;
    if (existsSync(newPath)) {
      log.warn("migration skipped: both legacy and new path exist; operator must resolve", {
        oldPath,
        newPath,
      });
      continue;
    }
    // renameSync is atomic on the same filesystem. A throw (e.g. cross-device)
    // propagates and stops startup — fail loud, no partial retry.
    renameSync(oldPath, newPath);
  }

  // Phase 3: create remaining migration-target subdirectories. Covers fresh
  // installs (no legacy paths to migrate) and legacy installs where a given
  // legacy path was absent.
  const subdirs = [
    sessionsDir(home),
    memoryDir(home),
    piAgentDir(home),
    workdirPath(home),
    subagentsRoot(home),
    namedAgentsRoot(home),
    skillsPath(home),
  ];
  for (const dir of subdirs) {
    mkdirSync(dir, { recursive: true });
  }
}
