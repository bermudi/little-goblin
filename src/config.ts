import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import {
  ConfigFileSchema,
  type ConfigFile,
  type EmbeddingsConfig,
  type ExternalAgentsConfig,
  type McpConfig,
  type SettingsConfig,
} from "./schema.ts";
import { resolveConfigValue } from "./resolve-value.ts";
import { goblinConfigPath, sessionsDir, stateDir, scratchDir } from "./sessions/paths.ts";
import { piAgentDir } from "./pi-host.ts";
import { goblinSkillsPath, personalEnvironmentSkillsPath, workspacePath } from "./workspace/paths.ts";
import { memoryDir } from "./memory/paths.ts";
import { namedAgentsRoot } from "./subagents/paths.ts";
import { delegatedWorkRunsRoot } from "./delegated-work/paths.ts";

/** Resolve `$GOBLIN_HOME` from the environment with the shared default. */
export function resolveGoblinHome(): string {
  return process.env.GOBLIN_HOME ?? join(homedir(), ".goblin");
}

export interface Config {
  botToken: string;
  allowedTgUserIds: Set<number>;
  /** Model id — must be a key in `MODELS` (see src/agent/models.ts). */
  modelName: string;
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
  /** External agent runner configuration. */
  externalAgents?: ExternalAgentsConfig;
  /** MCP bridge configuration. */
  mcp?: McpConfig;
  /** Memory embeddings endpoint configuration (overrides env fallbacks per key). */
  embeddings?: EmbeddingsConfig;
  /**
   * Optional loopback Settings Mini App API (decision 0049). Undefined or
   * disabled means no listener and no Telegram entry; the deployment owns the
   * stable port and public URL when enabled.
   */
  settings?: SettingsConfig;
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
  const goblinHome = resolveGoblinHome();
  const configFilePath = goblinConfigPath(goblinHome);

  // Read and parse config file
  let raw: unknown;
  try {
    const content = readFileSync(configFilePath, "utf-8");
    raw = JSON5.parse(content);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Config file not found: ${configFilePath}`);
    }
    throw new Error(`Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve all string values in the raw config object (with `!command`
  // execution — this is boot), then validate the resolved tree.
  const boot = validateBootConfig(raw, { executeCommands: true });
  if (!boot.bootable) {
    throw new Error(`Config validation failed: ${boot.issues}`);
  }
  const cfg = boot.config!;

  // Build frozen Config object
  const config: Config = Object.freeze({
    botToken: cfg.botToken,
    allowedTgUserIds: new Set(cfg.allowedUsers),
    modelName: cfg.model,
    openrouterApiKey: cfg.openrouterApiKey,
    openaiApiKey: cfg.openaiApiKey,
    anthropicApiKey: cfg.anthropicApiKey,
    zaiApiKey: cfg.zaiApiKey,
    opencodeApiKey: cfg.opencodeApiKey,
    goblinHome,
    logLevel: cfg.logLevel,
    toolVisibility: cfg.toolVisibility,
    favorites: cfg.favorites ?? [],
    voiceName: cfg.voiceName,
    groqApiKey: cfg.groqApiKey,
    asrModel: cfg.asrModel,
    externalAgents: cfg.externalAgents,
    mcp: cfg.mcp,
    embeddings: cfg.embeddings,
    settings: cfg.settings,
  });

  if (config.externalAgents) {
    Object.freeze(config.externalAgents);
    Object.freeze(config.externalAgents.backends);
  }

  if (config.mcp) {
    Object.freeze(config.mcp);
    if (config.mcp.enabled) {
      Object.freeze(config.mcp.enabled);
    }
  }

  if (config.embeddings) {
    Object.freeze(config.embeddings);
  }

  if (config.settings) {
    Object.freeze(config.settings);
    if (config.settings.allowedOrigins) {
      Object.freeze(config.settings.allowedOrigins);
    }
  }

  return config;
}

/**
 * Recursively resolve all string values in an object using resolveConfigValue().
 * Handles arrays and nested objects. When `executeCommands` is false, `!
 * command` values pass through unresolved (see `validateBootConfig`).
 */
function resolveAllStrings(obj: Record<string, unknown>, executeCommands: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveValue(value, executeCommands);
  }
  return result;
}

/**
 * Resolve a single value: strings get resolved, arrays get their strings resolved,
 * nested objects are resolved recursively, other values pass through.
 */
function resolveValue(value: unknown, executeCommands: boolean): unknown {
  if (typeof value === "string") {
    // Guard contexts (Settings store validation, the restart boot-loop guard)
    // must stay side-effect-free, so `!command` values are not executed
    // there; the literal passes through exactly as boot will find it.
    if (!executeCommands && value.startsWith("!")) {
      return value;
    }
    return resolveConfigValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, executeCommands));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return resolveAllStrings(value as Record<string, unknown>, executeCommands);
  }
  return value;
}

export interface BootConfigValidation {
  /** True when boot would accept this config (resolved tree passes the schema). */
  readonly bootable: boolean;
  /** Compact `path: message` issue list; empty when bootable. */
  readonly issues: string;
  /** The schema-parsed resolved config; defined only when bootable. */
  readonly config?: ConfigFile;
}

/**
 * Validate a parsed goblin.json5 tree exactly the way boot (`loadConfig`)
 * validates it: resolve every string value and validate the resolved tree
 * against `ConfigFileSchema`. This is the single boot-equivalence authority
 * shared by boot and the deployment-config guards (Settings store pre-commit,
 * restart boot-loop guard), so a raw-valid but unbootable config (e.g. an
 * env-style literal that resolves to nothing) is rejected before it can be
 * committed or restarted into.
 *
 * Deliberate boundary: `!command` values are executed only when
 * `executeCommands` is true (boot). Validation in guard contexts runs without
 * side effects, so a command value passes through as a literal string — never
 * rejected, never run. Boot itself resolves it; a failing command on a
 * boot-required field is a blind spot the side-effect-free guard cannot
 * close. Set env names resolve from the live process environment — the same
 * environment boot uses — so required fields that only resolve via a
 * now-missing env name are correctly rejected.
 */
export function validateBootConfig(
  raw: unknown,
  options?: { executeCommands?: boolean },
): BootConfigValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { bootable: false, issues: "config must be a top-level object" };
  }
  const resolved = resolveAllStrings(raw as Record<string, unknown>, options?.executeCommands === true);
  const parsed = ConfigFileSchema.safeParse(resolved);
  if (parsed.success) {
    return { bootable: true, issues: "", config: parsed.data };
  }
  return {
    bootable: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}

export interface GoblinHomeDirectory {
  /** Stable diagnostic label relative to `$GOBLIN_HOME`. */
  readonly label: string;
  /** Absolute path constructed through the owning path helper. */
  readonly path: string;
}

/**
 * Canonical deployment-owned inventory of directories startup materializes.
 * Layout validation must use this rather than reproducing a partial list.
 */
export function requiredGoblinHomeDirectories(home: string): readonly GoblinHomeDirectory[] {
  return [
    { label: "workspace", path: workspacePath(home) },
    { label: ".agents/skills", path: goblinSkillsPath(home) },
    { label: "workspace/.agents/skills", path: personalEnvironmentSkillsPath(home) },
    { label: "workspace/agents", path: namedAgentsRoot(home) },
    { label: "state", path: stateDir(home) },
    { label: "state/sessions", path: sessionsDir(home) },
    { label: "state/memory", path: memoryDir(home) },
    { label: "state/pi", path: piAgentDir(home) },
    { label: "state/delegated-work/runs", path: delegatedWorkRunsRoot(home) },
    { label: "scratch", path: scratchDir(home) },
  ];
}

/**
 * Ensure GOBLIN_HOME directory exists with required subdirectories.
 * Call once at startup before any consumer tries to use the paths.
 *
 * Creates the canonical three-group layout:
 *   workspace/  — user-authored prompt files and the personal execution CWD
 *   .agents/    — deployment-wide Goblin skill catalog
 *   state/      — machine-managed state
 *   scratch/    — ephemeral generic subagent instance data (not a personal workdir)
 *
 * Per decision `config-startup-filesystem-mutation` (0007), this function is
 * exempt from the AGENTS.md "Don't touch $GOBLIN_HOME" guardrail for
 * directory creation. Per decision `path-helper-only-path-construction`
 * (0008), all path construction here goes through the path-helper modules.
 */
export function ensureGoblinHome(cfg: Config): void {
  const home = cfg.goblinHome;
  for (const dir of [home, ...requiredGoblinHomeDirectories(home).map(({ path }) => path)]) {
    mkdirSync(dir, { recursive: true });
  }
}
