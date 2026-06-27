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
});

describe("ensureGoblinHome", () => {
  it("creates required directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
    const cfg = {
      goblinHome: tempDir,
      botToken: "test",
      allowedTgUserIds: new Set([123]),
      modelName: "test",
      logLevel: "info" as const,
      toolVisibility: "standard" as const,
      skillSources: "goblin-only" as const,
      favorites: [],
    };

    ensureGoblinHome(cfg);

    const expectedDirs = [
      "sessions", "skills", "workdir", "goblin", "agents", "subagents",
    ];
    for (const sub of expectedDirs) {
      expect(existsSync(join(tempDir, sub))).toBe(true);
    }

    // Cleanup
    rmSync(tempDir, { recursive: true });
  });
});
