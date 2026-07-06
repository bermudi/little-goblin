import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main, parseIdList, buildConfig } from "./onboard.ts";
import { DEFAULT_AGENTS_TEMPLATE, buildSoulTemplate, createMissingPromptFiles } from "./onboard.ts";
import { agentsMdPath, soulMdPath } from "./workspace/paths.ts";

describe("onboard", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "goblin-onboard-test-"));
    process.env.GOBLIN_HOME = tempDir;
    // Clear input to simulate interactive mode without breaking
    // We'll test the actual main() behavior
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("exits when config already exists", async () => {
    // Create existing config
    writeFileSync(join(tempDir, "goblin.json5"), "{}");
    // SOUL.md/AGENTS.md live under workspace/ — ensure the parent exists.
    mkdirSync(dirname(soulMdPath(tempDir)), { recursive: true });
    writeFileSync(soulMdPath(tempDir), "existing soul\n");
    writeFileSync(agentsMdPath(tempDir), "existing agents\n");

    let exited = false;
    const originalExit = process.exit;
    (process as { exit: typeof originalExit }).exit = ((code?: number) => {
      exited = true;
      expect(code).toBe(1);
      throw new Error("exit called");
    }) as typeof process.exit;

    try {
      await main();
    } catch (err) {
      if ((err as Error).message === "exit called") {
        // expected
      } else {
        throw err;
      }
    } finally {
      (process as { exit: typeof originalExit }).exit = originalExit;
    }

    expect(exited).toBe(true);
  });
});

// Test helper functions directly
describe("onboard helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "goblin-onboard-helper-test-"));
    // SOUL.md/AGENTS.md live under workspace/ — pre-creating them needs the parent.
    mkdirSync(dirname(soulMdPath(tempDir)), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("prompt file migration", () => {
    it("creates missing SOUL.md and AGENTS.md", () => {
      const result = createMissingPromptFiles(tempDir, "Moss");

      expect(result).toEqual({ createdSoul: true, createdAgents: true });
      expect(readFileSync(soulMdPath(tempDir), "utf-8")).toBe(buildSoulTemplate("Moss"));
      expect(readFileSync(agentsMdPath(tempDir), "utf-8")).toBe(DEFAULT_AGENTS_TEMPLATE);
    });

    it("does not overwrite existing prompt files", () => {
      writeFileSync(soulMdPath(tempDir), "existing soul\n");
      writeFileSync(agentsMdPath(tempDir), "existing agents\n");

      const result = createMissingPromptFiles(tempDir, "Moss");

      expect(result).toEqual({ createdSoul: false, createdAgents: false });
      expect(readFileSync(soulMdPath(tempDir), "utf-8")).toBe("existing soul\n");
      expect(readFileSync(agentsMdPath(tempDir), "utf-8")).toBe("existing agents\n");
    });

    it("warns when AGENTS.md exists without SOUL.md and does not copy AGENTS content", () => {
      const warnings: string[] = [];
      writeFileSync(agentsMdPath(tempDir), "old identity from agents\n");

      const result = createMissingPromptFiles(tempDir, "Moss", (message) => warnings.push(message));

      expect(result).toEqual({ createdSoul: true, createdAgents: false });
      expect(warnings[0]).toContain("Existing AGENTS.md found without SOUL.md");
      expect(readFileSync(soulMdPath(tempDir), "utf-8")).toContain("# Moss");
      expect(readFileSync(soulMdPath(tempDir), "utf-8")).not.toContain("old identity from agents");
      expect(readFileSync(agentsMdPath(tempDir), "utf-8")).toBe("old identity from agents\n");
    });

    it("can create only missing AGENTS.md without touching existing SOUL.md", () => {
      writeFileSync(soulMdPath(tempDir), "existing soul\n");

      const result = createMissingPromptFiles(tempDir, "Ignored");

      expect(result).toEqual({ createdSoul: false, createdAgents: true });
      expect(readFileSync(soulMdPath(tempDir), "utf-8")).toBe("existing soul\n");
      expect(existsSync(agentsMdPath(tempDir))).toBe(true);
    });
  });

  describe("parseIdList", () => {
    it("parses single ID", () => {
      const result = parseIdList("123456");
      expect(result).toEqual([123456]);
    });

    it("parses comma-separated IDs", () => {
      const result = parseIdList("123, 456, 789");
      expect(result).toEqual([123, 456, 789]);
    });

    it("filters invalid values", () => {
      const result = parseIdList("123, abc, -456, 789");
      expect(result).toEqual([123, 789]);
    });

    it("returns undefined for empty input", () => {
      const result = parseIdList("");
      expect(result).toBeUndefined();
    });

    it("returns undefined for only invalid values", () => {
      const result = parseIdList("abc, xyz");
      expect(result).toBeUndefined();
    });
  });

  describe("buildConfig", () => {
    it("builds minimal config", () => {
      const answers = {
        botToken: "test-token",
        userId: 123456,
        model: "poe/test",
        logLevel: "info" as const,
      };
      const config = buildConfig(answers);
      expect(config).toContain('botToken: "test-token"');
      expect(config).toContain("allowedUsers: [123456]");
      expect(config).toContain('model: "poe/test"');
      expect(config).toContain('logLevel: "info"');
    });

    it("includes optional API keys", () => {
      const answers = {
        botToken: "test-token",
        userId: 123456,
        model: "poe/test",
        logLevel: "debug" as const,
        poeApiKey: "poe-key",
        openrouterApiKey: "or-key",
      };
      const config = buildConfig(answers);
      expect(config).toContain('poeApiKey: "poe-key"');
      expect(config).toContain('openrouterApiKey: "or-key"');
    });

    it("omits unset optional keys", () => {
      const answers = {
        botToken: "test-token",
        userId: 123456,
        model: "poe/test",
        logLevel: "warn" as const,
      };
      const config = buildConfig(answers);
      expect(config).not.toContain("poeApiKey");
      expect(config).not.toContain("openaiApiKey");
    });
  });
});


