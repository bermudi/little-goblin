import { access, constants, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import { resolveModel } from "./agent/models.ts";
import { preflightGoblinPromptFiles } from "./agent/system-prompt.ts";
import { atomicWrite } from "./fs.ts";
import { log } from "./log.ts";
import { skillsPath, workdirPath } from "./workspace/paths.ts";
import { sessionsDir } from "./sessions/paths.ts";
import { memoryDir } from "./memory/paths.ts";
import { runExternalAgentsPreflight } from "./external-agents/preflight.ts";

export interface PreflightContext {
  readonly check: (name: string, fn: () => void | Promise<void>) => Promise<void>;
}

/**
 * Run startup preflight checks before connecting to Telegram or starting the
 * scheduler. Throws on the first critical failure so the process exits with a
 * clear error instead of failing later in a turn.
 *
 * Optional checks (Telegram reachability, Edge TTS) log warnings but do not
 * block startup.
 */
export async function runPreflight(cfg: Config): Promise<void> {
  const ctx: PreflightContext = {
    check: async (name, fn) => {
      try {
        await fn();
        log.info("preflight ok", { check: name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Preflight failed: ${name}: ${message}`);
      }
    },
  };

  await ctx.check("config loads and validates", () => {
    // loadConfig() already ran before preflight; this check records that the
    // resolved config is present and frozen.
    if (!cfg.botToken || cfg.allowedTgUserIds.size === 0) {
      throw new Error("botToken and allowedUsers are required");
    }
  });

  await ctx.check("model API key is present", () => {
    resolveModel(cfg);
  });

  await ctx.check("prompt files", async () => {
    await preflightGoblinPromptFiles({ home: cfg.goblinHome, warn: log.warn });
  });

  await ctx.check("GOBLIN_HOME directories are writable", async () => {
    await checkDirectoryWritable(cfg.goblinHome);
    await checkDirectoryWritable(join(cfg.goblinHome, "workspace"));
    await checkDirectoryWritable(join(cfg.goblinHome, "scratch"));
    await checkDirectoryWritable(skillsPath(cfg.goblinHome));
    await checkDirectoryWritable(join(cfg.goblinHome, "state"));
    await checkDirectoryWritable(sessionsDir(cfg.goblinHome));
    await checkDirectoryWritable(memoryDir(cfg.goblinHome));
    await checkDirectoryWritable(workdirPath(cfg.goblinHome));
  });

  await ctx.check("atomic write works in state/", async () => {
    await checkAtomicWrite(join(cfg.goblinHome, "state"));
  });

  // Optional: best-effort checks that should not block startup on flakes.
  await checkTelegramToken(cfg.botToken).catch((err) => {
    log.warn("preflight: could not verify Telegram token", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  await checkEdgeTtsAvailable().catch((err) => {
    log.warn("preflight: Edge TTS not available", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (cfg.groqApiKey) {
    await checkGroqAsrAvailable(cfg.groqApiKey).catch((err) => {
      log.warn("preflight: Groq ASR not reachable", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (cfg.externalAgents?.backends.length) {
    await ctx.check("external agent backends are reachable", async () => {
      await runExternalAgentsPreflight(cfg);
    });
  }
}

function checkDirectoryWritable(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    access(dir, constants.W_OK, (err) => {
      if (err) {
        const reason = err.code === "ENOENT"
          ? "directory does not exist"
          : "directory not writable";
        reject(new Error(`${reason}: ${dir}: ${err.message}`));
        return;
      }
      // Write and immediately remove a probe file to prove writability.
      const probe = join(dir, `.preflight-${randomBytes(6).toString("hex")}.tmp`);
      try {
        writeFileSync(probe, "");
        rmSync(probe, { force: true });
        resolve();
      } catch (writeErr) {
        reject(new Error(`directory not writable: ${dir}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`));
      }
    });
  });
}

async function checkAtomicWrite(dir: string): Promise<void> {
  const expected = `preflight-${randomBytes(6).toString("hex")}`;
  const target = join(dir, `.preflight-atomic-${randomBytes(6).toString("hex")}.txt`);
  atomicWrite(target, expected);
  const actual = await import("node:fs").then(({ readFileSync }) => readFileSync(target, "utf-8"));
  if (actual !== expected) {
    throw new Error(`atomic write read-back mismatch: expected ${expected}, got ${actual}`);
  }
  rmSync(target, { force: true });
}

async function checkTelegramToken(token: string): Promise<void> {
  const req = new Request(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(5_000),
  });
  try {
    const res = await fetch(req);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API returned ${res.status}: ${body}`);
    }
  } catch (err) {
    throw new Error(`Telegram API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkEdgeTtsAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("uvx", ["edge-tts", "--version"], { stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error("uvx edge-tts --version timed out"));
    }, 10_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to start uvx edge-tts: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`uvx edge-tts --version exited ${code}`));
      }
    });
  });
}

async function checkGroqAsrAvailable(apiKey: string): Promise<void> {
  const req = new Request("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  let res: Response;
  try {
    res = await fetch(req);
  } catch (err) {
    throw new Error(`Groq ASR unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Groq ASR API returned HTTP ${res.status}`);
  }
}
