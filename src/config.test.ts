import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ensureGoblinHome } from "./config.ts";
import { clearResolveCache } from "./resolve-value.ts";
import { log } from "./log.ts";

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
    // No legacy root-level dirs leak on a fresh install.
    for (const legacy of ["sessions", "memory", "workdir", "goblin", "agents", "subagents", "skills"]) {
      expect(existsSync(join(tempDir, legacy)), `legacy ${legacy} should not exist`).toBe(false);
    }
  });

  it("is idempotent (already-migrated tree is untouched)", () => {
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

  it("migrates legacy root-level directories to their new locations", () => {
    // Populate legacy layout with content that must survive the move.
    mkdirSync(join(tempDir, "sessions", "abc"), { recursive: true });
    writeFileSync(join(tempDir, "sessions", "abc", "state.json"), "{}");
    mkdirSync(join(tempDir, "memory", "general"), { recursive: true });
    writeFileSync(join(tempDir, "memory", "general", "memory.md"), "notes");
    mkdirSync(join(tempDir, "agents", "researcher"), { recursive: true });
    writeFileSync(join(tempDir, "agents", "researcher", "AGENTS.md"), "prompt");
    mkdirSync(join(tempDir, "subagents"));
    mkdirSync(join(tempDir, "skills"));
    mkdirSync(join(tempDir, "workdir"));
    mkdirSync(join(tempDir, "goblin"));
    writeFileSync(join(tempDir, "goblin", "auth.json"), "{}");

    ensureGoblinHome(homeConfig(tempDir));

    // Legacy content now lives under the new tree.
    expect(existsSync(join(tempDir, "state", "sessions", "abc", "state.json"))).toBe(true);
    expect(existsSync(join(tempDir, "state", "memory", "general", "memory.md"))).toBe(true);
    expect(existsSync(join(tempDir, "workspace", "agents", "researcher", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(tempDir, "state", "pi", "auth.json"))).toBe(true);
    // Legacy root-level paths are gone (renameSync, not copy).
    for (const legacy of ["sessions", "memory", "agents", "subagents", "skills", "workdir", "goblin"]) {
      expect(existsSync(join(tempDir, legacy)), `legacy ${legacy} should be gone`).toBe(false);
    }
    // All expected dirs still present.
    for (const sub of EXPECTED_DIRS) {
      expect(existsSync(join(tempDir, sub))).toBe(true);
    }
  });

  it("migrates legacy root-level files (config.json, schedules.json, SOUL.md, AGENTS.md)", () => {
    writeFileSync(join(tempDir, "config.json"), "{}");
    writeFileSync(join(tempDir, "schedules.json"), "[]");
    writeFileSync(join(tempDir, "SOUL.md"), "soul");
    writeFileSync(join(tempDir, "AGENTS.md"), "rules");
    writeFileSync(join(tempDir, "topic-settings.json"), "{}");

    ensureGoblinHome(homeConfig(tempDir));

    expect(existsSync(join(tempDir, "state", "bindings.json"))).toBe(true);
    expect(existsSync(join(tempDir, "state", "schedules.json"))).toBe(true);
    expect(existsSync(join(tempDir, "state", "topic-settings.json"))).toBe(true);
    expect(existsSync(join(tempDir, "workspace", "SOUL.md"))).toBe(true);
    expect(existsSync(join(tempDir, "workspace", "AGENTS.md"))).toBe(true);
    // Legacy files gone.
    for (const f of ["config.json", "schedules.json", "topic-settings.json", "SOUL.md", "AGENTS.md"]) {
      expect(existsSync(join(tempDir, f)), `legacy ${f} should be gone`).toBe(false);
    }
  });

  it("migrates legacy pi-agent/ directly to state/pi/", () => {
    mkdirSync(join(tempDir, "pi-agent"));
    writeFileSync(join(tempDir, "pi-agent", "auth.json"), "{}");

    ensureGoblinHome(homeConfig(tempDir));

    expect(existsSync(join(tempDir, "state", "pi", "auth.json"))).toBe(true);
    expect(existsSync(join(tempDir, "pi-agent"))).toBe(false);
  });

  it("migrates legacy directories even when top-level groups already exist", () => {
    // Simulate a partially-initialized home: the group dirs exist (e.g. from a
    // prior aborted run or a manual mkdir) but legacy content is still at root.
    mkdirSync(join(tempDir, "workspace"));
    mkdirSync(join(tempDir, "state"));
    mkdirSync(join(tempDir, "scratch"));
    mkdirSync(join(tempDir, "sessions", "abc"), { recursive: true });
    writeFileSync(join(tempDir, "sessions", "abc", "state.json"), "{}");

    ensureGoblinHome(homeConfig(tempDir));

    expect(existsSync(join(tempDir, "state", "sessions", "abc", "state.json"))).toBe(true);
    expect(existsSync(join(tempDir, "sessions"))).toBe(false);
  });

  it("warns and skips when both legacy and new paths exist", () => {
    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    // Legacy file at root AND new file already in place.
    writeFileSync(join(tempDir, "config.json"), "legacy");
    mkdirSync(join(tempDir, "state"), { recursive: true });
    writeFileSync(join(tempDir, "state", "bindings.json"), "new");

    ensureGoblinHome(homeConfig(tempDir));

    // Both still present — neither overwritten.
    expect(existsSync(join(tempDir, "config.json"))).toBe(true);
    expect(existsSync(join(tempDir, "state", "bindings.json"))).toBe(true);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("migration skipped"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it("propagates renameSync failures instead of swallowing them", () => {
    // Force a real OS-level rename failure: legacy `sessions/` exists and
    // `state/sessions` does not (so the migration guard tries to rename), but
    // `state/` is read-only, so renameSync throws EACCES. This proves
    // migration errors stop startup (fail loud) rather than being swallowed
    // or partially retried.
    mkdirSync(join(tempDir, "sessions", "abc"), { recursive: true });
    writeFileSync(join(tempDir, "sessions", "abc", "state.json"), "{}");
    mkdirSync(join(tempDir, "state"), { recursive: true });
    chmodSync(join(tempDir, "state"), 0o500);

    try {
      expect(() => ensureGoblinHome(homeConfig(tempDir))).toThrow();
      // Legacy path is still there — migration did not silently complete.
      expect(existsSync(join(tempDir, "sessions"))).toBe(true);
    } finally {
      // Restore writability so afterEach's rmSync can clean up.
      chmodSync(join(tempDir, "state"), 0o700);
    }
  });
});
