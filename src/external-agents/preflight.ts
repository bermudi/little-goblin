import type { Config } from "../config.ts";
import { prepareEnv } from "./env.ts";
import { CLAUDE_ACP_BRIDGE_PIN, resolveClaudeBridge, type QualifiedBackend } from "./host.ts";

const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Admission check for one qualified backend (decision 0044): Claude resolves
 * the exact-version-pinned ACP bridge; Devin probes its native server
 * executable. Nothing else is exercised — no Codex, no PTY fallback.
 */
export async function checkQualifiedBackend(backend: QualifiedBackend): Promise<void> {
  if (backend === "claude") {
    const bridge = resolveClaudeBridge();
    if (bridge.version !== CLAUDE_ACP_BRIDGE_PIN) {
      throw new Error(
        `claude ACP bridge version ${bridge.version} does not match pin ${CLAUDE_ACP_BRIDGE_PIN}`,
      );
    }
    return;
  }
  await runVersionCheck(backend);
}

export async function runExternalAgentsPreflight(cfg: Config): Promise<void> {
  const config = cfg.externalAgents;
  if (!config || config.backends.length === 0) {
    return;
  }

  for (const backend of config.backends) {
    await checkQualifiedBackend(backend);
  }
}

async function runVersionCheck(backend: QualifiedBackend): Promise<void> {
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
