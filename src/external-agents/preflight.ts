import type { Config } from "../config.ts";
import { prepareEnv } from "./env.ts";

const PREFLIGHT_TIMEOUT_MS = 10_000;

export async function runExternalAgentsPreflight(cfg: Config): Promise<void> {
  const config = cfg.externalAgents;
  if (!config || config.backends.length === 0) {
    return;
  }

  for (const backend of config.backends) {
    await runVersionCheck(backend);
  }

  if (config.ptyFallback) {
    await runAgentPtyListSessions();
  }
}

async function runVersionCheck(backend: "codex" | "claude" | "devin"): Promise<void> {
  const process = Bun.spawn({
    cmd: [backend, "--version"],
    env: prepareEnv(),
    timeout: PREFLIGHT_TIMEOUT_MS,
    stdout: "ignore",
    stderr: "ignore",
  });

  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${backend} --version failed with exit code ${exitCode}`);
  }
}

async function runAgentPtyListSessions(): Promise<void> {
  const process = Bun.spawn({
    cmd: ["agent-pty", "list-sessions"],
    env: prepareEnv(),
    timeout: PREFLIGHT_TIMEOUT_MS,
    stdout: "ignore",
    stderr: "ignore",
  });

  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`agent-pty list-sessions failed with exit code ${exitCode}`);
  }
}
