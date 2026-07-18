import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ensureGoblinHome } from "./config.ts";
import { clearResolveCache } from "./resolve-value.ts";

describe("loadConfig", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearResolveCache();
    // Create temp directory for test configs
    tempDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
    process.env.GOBLIN_HOME = tempDir;
  });

  afterEach(() => {
    clearResolveCache();
    // Restore env
    process.env = originalEnv;
    // Clean up temp dir
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("loads valid config file", () => {
    const configContent = `{
      botToken: "test-token-123",
      allowedUsers: [123456, 789012],
      model: "poe/Claude-Sonnet-4.6",
      logLevel: "debug",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();

    expect(cfg.botToken).toBe("test-token-123");
    expect(cfg.allowedTgUserIds).toEqual(new Set([123456, 789012]));
    expect(cfg.modelName).toBe("poe/Claude-Sonnet-4.6");
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.goblinHome).toBe(tempDir);
  });

  it("throws when config file is missing", () => {
    expect(() => loadConfig()).toThrow("Config file not found");
  });

  it("throws when required field is missing", () => {
    const configContent = `{
      botToken: "test-token",
      // missing allowedUsers and model
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("resolves env var references", () => {
    process.env.TEST_BOT_TOKEN = "resolved-from-env";
    const configContent = `{
      botToken: "TEST_BOT_TOKEN",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.botToken).toBe("resolved-from-env");
    delete process.env.TEST_BOT_TOKEN;
  });

  it("resolves shell commands", () => {
    const configContent = `{
      botToken: "!echo shell-token",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.botToken).toBe("shell-token");
  });

  it("rejects invalid Zod schema (negative user IDs)", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123, -456],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("rejects invalid Zod schema (empty allowedUsers)", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("uses default logLevel when not specified", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.logLevel).toBe("info");
  });

  it("defaults skillSources to goblin-only when not specified", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.skillSources).toBe("goblin-only");
  });

  it("defaults voiceName when not specified", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.voiceName).toBe("en-US-EmmaMultilingualNeural");
  });

  it("loads voiceName from config file", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      voiceName: "en-US-AndrewMultilingualNeural",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.voiceName).toBe("en-US-AndrewMultilingualNeural");
  });

  it("accepts every valid skillSources value", () => {
    for (const skillSources of ["goblin-only", "user"] as const) {
      const configContent = `{
        botToken: "test",
        allowedUsers: [123],
        model: "poe/test",
        skillSources: "${skillSources}",
      }`;
      writeFileSync(join(tempDir, "goblin.json5"), configContent);

      const cfg = loadConfig();
      expect(cfg.skillSources).toBe(skillSources);
    }
  });

  it("rejects removed auto skillSources value", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      skillSources: "auto",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("rejects invalid skillSources values", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      skillSources: "everything",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("includes optional API keys when present", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      poeApiKey: "poe-key",
      openrouterApiKey: "or-key",
      openaiApiKey: "oa-key",
      anthropicApiKey: "anth-key",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.poeApiKey).toBe("poe-key");
    expect(cfg.openrouterApiKey).toBe("or-key");
    expect(cfg.openaiApiKey).toBe("oa-key");
    expect(cfg.anthropicApiKey).toBe("anth-key");
  });

  it("returns frozen config object", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("defaults asrModel to whisper-large-v3-turbo when not specified", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.asrModel).toBe("whisper-large-v3-turbo");
  });

  it("loads asrModel override from config file", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      asrModel: "whisper-large-v3",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.asrModel).toBe("whisper-large-v3");
  });

  it("rejects an invalid asrModel value", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      asrModel: "whisper-1",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("resolves groqApiKey from environment", () => {
    process.env.GROQ_API_KEY = "groq-secret";
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      groqApiKey: "GROQ_API_KEY",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.groqApiKey).toBe("groq-secret");
    delete process.env.GROQ_API_KEY;
  });

  it("leaves groqApiKey unset when the env reference is unresolved", () => {
    delete process.env.GROQ_API_KEY;
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      groqApiKey: "GROQ_API_KEY",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    // Unresolved env-style name must NOT leak the literal into Config.
    expect(cfg.groqApiKey).toBeUndefined();
  });

  it("starts successfully when groqApiKey is absent", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.groqApiKey).toBeUndefined();
  });

  it("applies mcp defaults when the block is present but fields are omitted", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: {},
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.mcp).toBeDefined();
    expect(cfg.mcp?.enabled).toBeUndefined();
    expect(cfg.mcp?.configPath).toBeUndefined();
    expect(cfg.mcp?.defaultTimeoutMs).toBe(120000);
    expect(cfg.mcp?.maxResultChars).toBe(16000);
  });

  it("loads mcp.enabled from the config file", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: { enabled: ["tavily", "deepwiki"] },
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.mcp?.enabled).toEqual(["tavily", "deepwiki"]);
  });

  it("accepts an empty mcp.enabled array", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: { enabled: [] },
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.mcp?.enabled).toEqual([]);
  });

  it("rejects mcp.defaultTimeoutMs below the minimum", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: { defaultTimeoutMs: 1000 },
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("rejects mcp.defaultTimeoutMs above the maximum", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: { defaultTimeoutMs: 3600000 },
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("rejects mcp.maxResultChars below the minimum", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: { maxResultChars: 100 },
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    expect(() => loadConfig()).toThrow("Config validation failed");
  });

  it("leaves mcp undefined when the block is absent", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(cfg.mcp).toBeUndefined();
  });

  it("freezes the mcp block and its enabled array at load time", () => {
    const configContent = `{
      botToken: "test",
      allowedUsers: [123],
      model: "poe/test",
      mcp: { enabled: ["tavily"] },
    }`;
    writeFileSync(join(tempDir, "goblin.json5"), configContent);

    const cfg = loadConfig();
    expect(Object.isFrozen(cfg.mcp)).toBe(true);
    expect(Object.isFrozen(cfg.mcp?.enabled)).toBe(true);
  });
});

/** Minimal Config fixture for ensureGoblinHome — only goblinHome is read. */
function homeConfig(goblinHome: string) {
  return {
    goblinHome,
    botToken: "test",
    allowedTgUserIds: new Set([123]),
    modelName: "test",
    logLevel: "info" as const,
    toolVisibility: "standard" as const,
    skillSources: "goblin-only" as const,
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

/** Every directory ensureGoblinHome must leave on disk, as paths under home. */
const EXPECTED_DIRS = [
  "workspace",
  "workspace/skills",
  "workspace/agents",
  "state",
  "state/sessions",
  "state/memory",
  "state/pi",
  "scratch",
  "scratch/workdir",
  "scratch/subagents",
];

describe("ensureGoblinHome", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates the new tree on a fresh install", () => {
    ensureGoblinHome(homeConfig(tempDir));

    for (const sub of EXPECTED_DIRS) {
      expect(existsSync(join(tempDir, sub)), `expected ${sub} to exist`).toBe(true);
    }
  });

  it("is idempotent (existing tree is untouched)", () => {
    ensureGoblinHome(homeConfig(tempDir));
    // A sentinel file inside state/sessions proves the second run doesn't wipe it.
    const sentinel = join(tempDir, "state", "sessions", "sentinel");
    writeFileSync(sentinel, "persist");

    ensureGoblinHome(homeConfig(tempDir));

    expect(existsSync(sentinel)).toBe(true);
    for (const sub of EXPECTED_DIRS) {
      expect(existsSync(join(tempDir, sub))).toBe(true);
    }
  });
});
