import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { runPreflight, type OptionalPreflightChecks } from "./preflight.ts";
import * as goblinFs from "./fs.ts";
import { log } from "./log.ts";
import type { Config } from "./config.ts";

function buildConfig(overrides: Partial<Config> & { goblinHome: string }): Config {
  return {
    botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    allowedTgUserIds: new Set([123456789]),
    modelName: "anthropic/claude-sonnet-4.6",
    anthropicApiKey: "sk-test",
    logLevel: "info",
    toolVisibility: "standard",
    favorites: [],
    voiceName: "en-US-EmmaMultilingualNeural",
    ...overrides,
  } as Config;
}

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-preflight-"));
  mkdirSync(join(home, "workspace"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  mkdirSync(join(home, "workspace", ".agents", "skills"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "state", "sessions"), { recursive: true });
  mkdirSync(join(home, "state", "memory"), { recursive: true });
  mkdirSync(join(home, "state", "delegated-work", "runs"), { recursive: true });
  mkdirSync(join(home, "scratch"), { recursive: true });
  writeFileSync(join(home, "workspace", "SOUL.md"), "# Test Goblin\n");
  return home;
}

function testOptionalChecks(overrides: Partial<OptionalPreflightChecks> = {}): OptionalPreflightChecks {
  return {
    checkTelegramToken: async () => {},
    checkEdgeTtsAvailable: async () => {},
    checkGroqAsrAvailable: async () => {},
    ...overrides,
  };
}

function runPreflightForTest(
  cfg: Config,
  optionalChecks: Partial<OptionalPreflightChecks> = {},
): Promise<void> {
  return runPreflight(cfg, testOptionalChecks(optionalChecks));
}

describe("runPreflight", () => {
  let home: string;

  beforeEach(() => {
    home = setupHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("passes with a valid config and writable home without external probes", async () => {
    const cfg = buildConfig({ goblinHome: home });
    const calls: string[] = [];

    await expect(runPreflightForTest(cfg, {
      checkTelegramToken: async () => { calls.push("telegram"); },
      checkEdgeTtsAvailable: async () => { calls.push("edge-tts"); },
      checkGroqAsrAvailable: async () => { calls.push("groq"); },
    })).resolves.toBeUndefined();

    expect(calls).toEqual(["telegram", "edge-tts"]);
  });

  test("fails when the model API key is missing", async () => {
    const cfg = buildConfig({
      goblinHome: home,
      modelName: "anthropic/claude-sonnet-4.6",
      anthropicApiKey: undefined,
    });
    await expect(runPreflightForTest(cfg)).rejects.toThrow("Preflight failed: model API key is present");
  });

  test("fails when SOUL.md is missing", async () => {
    rmSync(join(home, "workspace", "SOUL.md"), { force: true });
    const cfg = buildConfig({ goblinHome: home });
    await expect(runPreflightForTest(cfg)).rejects.toThrow("Preflight failed: prompt files");
  });

  test("fails when state directory is not writable", async () => {
    // Replace state/ with a regular file so any path under it is unwritable.
    rmSync(join(home, "state"), { recursive: true, force: true });
    writeFileSync(join(home, "state"), "not a directory");
    const cfg = buildConfig({ goblinHome: home });
    await expect(runPreflightForTest(cfg)).rejects.toThrow("Preflight failed: GOBLIN_HOME directories are writable");
  });

  test("warns, but does not fail, when injected Telegram validation fails", async () => {
    const warn = spyOn(log, "warn");
    try {
      await expect(runPreflightForTest(buildConfig({ goblinHome: home }), {
        checkTelegramToken: async () => { throw new Error("simulated Telegram failure"); },
      })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("preflight: could not verify Telegram token", {
        error: "simulated Telegram failure",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("warns, but does not fail, when injected Edge TTS validation fails", async () => {
    const warn = spyOn(log, "warn");
    try {
      await expect(runPreflightForTest(buildConfig({ goblinHome: home }), {
        checkEdgeTtsAvailable: async () => { throw new Error("simulated Edge TTS failure"); },
      })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("preflight: Edge TTS not available", {
        error: "simulated Edge TTS failure",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("does not probe Groq ASR when it is not configured", async () => {
    const cfg = buildConfig({ goblinHome: home });
    let groqChecked = false;

    await expect(runPreflightForTest(cfg, {
      checkGroqAsrAvailable: async () => { groqChecked = true; },
    })).resolves.toBeUndefined();

    expect(groqChecked).toBe(false);
  });

  test("warns, but does not fail, when configured Groq ASR is unreachable", async () => {
    const cfg = buildConfig({ goblinHome: home, groqApiKey: "invalid-key" });
    const warn = spyOn(log, "warn");
    try {
      await expect(runPreflightForTest(cfg, {
        checkGroqAsrAvailable: async () => { throw new Error("simulated unreachable Groq"); },
      })).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith("preflight: Groq ASR not reachable", {
        error: "simulated unreachable Groq",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("fails when atomic write cannot rename", async () => {
    const spy = spyOn(goblinFs, "atomicWrite").mockImplementation(() => {
      throw new Error("simulated rename failure");
    });
    try {
      const cfg = buildConfig({ goblinHome: home });
      await expect(runPreflightForTest(cfg)).rejects.toThrow(
        "Preflight failed: atomic write works in state/",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
