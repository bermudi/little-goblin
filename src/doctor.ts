#!/usr/bin/env bun

/**
 * Doctor CLI: read-only local system health checks for little-goblin.
 *
 * Usage:
 *   bun run doctor
 *   bun run src/doctor.ts
 */

import { readdirSync, statSync, statfsSync } from "node:fs";
import { loadConfig, resolveGoblinHome } from "./config.ts";
import type { Config } from "./config.ts";
import { resolveModel } from "./agent/models.ts";
import type { ResolvedModel } from "./agent/models.ts";
import { ConversationStore } from "./sessions/conversation-store.ts";
import { isValidConversationId } from "./sessions/conversation.ts";
import {
  archivedStatePath,
  archiveDir,
  goblinConfigPath,
  scratchDir,
  sessionsDir,
  stateDir,
} from "./sessions/paths.ts";
import { memoryDbPath, memoryDir } from "./memory/paths.ts";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROVIDER, MemorySnapshot } from "./memory/db.ts";
import { MemoryBudget } from "./memory/budget.ts";
import { agentsMdPath, soulMdPath, workspacePath } from "./workspace/paths.ts";
import { CURRENT_STATE_VERSION, readStateVersion } from "./state-version.ts";
import { log } from "./log.ts";
import { prepareEnv } from "./external-agents/env.ts";
import { prepareMcpEnv } from "./mcp/env.ts";
import { resolveMcporterConfigPath } from "./mcp/paths.ts";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly warn?: boolean;
  readonly timedOut?: boolean;
}

function goblinHome(): string {
  return resolveGoblinHome();
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "[unstringifiable error]";
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function checkStateVersion(home: string): Promise<Check> {
  try {
    const version = readStateVersion(home);
    if (version === CURRENT_STATE_VERSION) {
      return {
        name: "state version",
        ok: true,
        detail: `state version ${version} matches expected ${CURRENT_STATE_VERSION}`,
      };
    }
    return {
      name: "state version",
      ok: false,
      detail: `state version mismatch: file has ${version}, expected ${CURRENT_STATE_VERSION}`,
    };
  } catch (err) {
    return {
      name: "state version",
      ok: false,
      detail: `cannot read state version: ${errorMessage(err)}`,
    };
  }
}

async function checkGoblinHomeDirs(home: string): Promise<Check> {
  const required: readonly [label: string, path: string][] = [
    ["workspace", workspacePath(home)],
    ["state", stateDir(home)],
    ["state/memory", memoryDir(home)],
    ["state/sessions", sessionsDir(home)],
    ["scratch", scratchDir(home)],
  ];
  const missing: string[] = [];

  try {
    if (!statSync(home).isDirectory()) {
      return { name: "GOBLIN_HOME", ok: false, detail: `not a directory: ${home}` };
    }
  } catch (err) {
    return {
      name: "GOBLIN_HOME",
      ok: false,
      detail: isNodeErrnoException(err) && err.code === "ENOENT"
        ? `missing: ${home}`
        : `cannot stat GOBLIN_HOME: ${errorMessage(err)}`,
    };
  }

  for (const [label, path] of required) {
    try {
      if (!statSync(path).isDirectory()) {
        missing.push(`${label} is not a directory`);
      }
    } catch {
      missing.push(`${label} is missing`);
    }
  }

  if (missing.length === 0) {
    return {
      name: "GOBLIN_HOME",
      ok: true,
      detail: `home exists at ${home}; subdirs: ${required.map(([label]) => label).join(", ")}`,
    };
  }
  return { name: "GOBLIN_HOME", ok: false, detail: missing.join("; ") };
}

async function checkMemory(home: string): Promise<Check> {
  const dbPath = memoryDbPath(home);
  let snapshot: MemorySnapshot | undefined;

  try {
    snapshot = new MemorySnapshot(dbPath);
  } catch (err) {
    return {
      name: "memory",
      ok: false,
      detail: `cannot open memory DB at ${dbPath}: ${errorMessage(err)}`,
    };
  }

  try {
    const entryCount = snapshot.selectOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memory_entries",
    )?.count ?? 0;

    const budget = new MemoryBudget();
    const usage = budget.usage(snapshot);

    const model = snapshot.getMeta("embedding_model") ?? process.env.GOBLIN_MEMORY_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    const provider = snapshot.getMeta("embedding_provider") ?? process.env.GOBLIN_MEMORY_EMBEDDING_PROVIDER ?? DEFAULT_EMBEDDING_PROVIDER;
    const reindexing = snapshot.getMeta("reindexing") === "true";
    const degraded = reindexing;

    const syncMeta = snapshot.getMeta("last_transcript_sync");
    const lastSync = syncMeta
      ? new Date(Number.parseInt(syncMeta, 10)).toISOString()
      : "never";

    const size = (() => {
      try {
        return statSync(dbPath).size;
      } catch {
        return 0;
      }
    })();

    return {
      name: "memory",
      ok: true,
      detail: `${entryCount} entries, budget ${usage.current} / ${usage.budget} chars, embedding ${model} (${provider}) ${degraded ? "degraded" : "ok"}, last sync ${lastSync}, db ${formatBytes(size)}`,
    };
  } catch (err) {
    return {
      name: "memory",
      ok: false,
      detail: `failed to query memory DB: ${errorMessage(err)}`,
    };
  } finally {
    snapshot.close();
  }
}

async function checkConversations(home: string): Promise<Check> {
  try {
    const store = new ConversationStore(home);
    const active = store.list().length;

    const archive = archiveDir(home);
    let archived = 0;
    try {
      for (const id of readdirSync(archive)) {
        if (!isValidConversationId(id)) continue;
        try {
          if (statSync(archivedStatePath(home, id)).isFile()) archived++;
        } catch {
          // skip archived entries with no state file
        }
      }
    } catch (err) {
      if (!isNodeErrnoException(err) || err.code !== "ENOENT") {
        return {
          name: "conversations",
          ok: false,
          detail: `cannot read archived conversations: ${errorMessage(err)}`,
        };
      }
    }

    return {
      name: "conversations",
      ok: true,
      detail: `${active} active, ${archived} archived`,
    };
  } catch (err) {
    return {
      name: "conversations",
      ok: false,
      detail: `cannot list conversations: ${errorMessage(err)}`,
    };
  }
}

async function checkConfig(): Promise<Check> {
  try {
    const cfg = loadConfig();
    const resolved = resolveModel(cfg);
    return {
      name: "config",
      ok: true,
      detail: `loaded ${goblinConfigPath(cfg.goblinHome)}; default model ${cfg.modelName} resolves to ${resolved.model.id} (${resolved.model.provider})`,
    };
  } catch (err) {
    return {
      name: "config",
      ok: false,
      detail: `config reload failed: ${errorMessage(err)}`,
    };
  }
}

async function checkFavorites(): Promise<Check> {
  try {
    const cfg = loadConfig();
    const favorites = cfg.favorites ?? [];
    if (favorites.length === 0) {
      return { name: "favorites", ok: true, detail: "0 favorites configured" };
    }

    const failures: string[] = [];
    for (const modelName of favorites) {
      try {
        resolveModel({ ...cfg, modelName });
      } catch (err) {
        failures.push(`${modelName}: ${errorMessage(err)}`);
      }
    }

    if (failures.length === 0) {
      return { name: "favorites", ok: true, detail: `${favorites.length} favorites resolve` };
    }
    return { name: "favorites", ok: false, detail: failures.join("; ") };
  } catch (err) {
    return {
      name: "favorites",
      ok: false,
      detail: `cannot load favorites: ${errorMessage(err)}`,
    };
  }
}

async function checkPromptFiles(home: string): Promise<Check> {
  const present = (path: string): boolean => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };

  const soulPresent = present(soulMdPath(home));
  const agentsPresent = present(agentsMdPath(home));

  if (soulPresent && agentsPresent) {
    return {
      name: "prompt files",
      ok: true,
      detail: `SOUL.md and AGENTS.md present`,
    };
  }

  // SOUL.md is mandatory at runtime (decision 0010: preflight throws on its
  // absence); AGENTS.md is optional, so its absence is a warn-level finding
  // that only fails under --strict, mirroring connectivity probes.
  if (!soulPresent) {
    const detail = agentsPresent
      ? "SOUL.md missing (critical)"
      : "SOUL.md missing (critical); AGENTS.md missing";
    return { name: "prompt files", ok: false, detail };
  }
  return {
    name: "prompt files",
    ok: false,
    warn: true,
    detail: "AGENTS.md missing (optional per decision 0010)",
  };
}

async function checkDisk(home: string): Promise<Check> {
  try {
    const stats = statfsSync(home);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return {
      name: "disk",
      ok: true,
      detail: `${formatBytes(free)} free / ${formatBytes(total)} total on ${home}`,
    };
  } catch (err) {
    return {
      name: "disk",
      ok: false,
      detail: `cannot statfs GOBLIN_HOME volume: ${errorMessage(err)}`,
    };
  }
}

async function runChecks(home: string): Promise<Check[]> {
  return Promise.all([
    checkStateVersion(home),
    checkGoblinHomeDirs(home),
    checkMemory(home),
    checkConversations(home),
    checkConfig(),
    checkFavorites(),
    checkPromptFiles(home),
    checkDisk(home),
  ]);
}

function formatStatus(check: Check): "fail" | "pass" | "timeout" | "warn" {
  if (check.ok) return "pass";
  if (check.timedOut) return "timeout";
  if (check.warn) return "warn";
  return "fail";
}

function formatLines(checks: Check[], strict: boolean): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${check.name}: ${formatStatus(check)} (${check.detail})`);
  }
  const passed = checks.filter((c) => c.ok).length;
  const hardFailed = checks.filter((c) => !c.ok && !c.warn).length;
  const warnings = checks.filter((c) => !c.ok && c.warn).length;
  if (strict) {
    lines.push(`${passed} passed, ${hardFailed + warnings} failed (strict)`);
  } else if (warnings > 0) {
    lines.push(`${passed} passed, ${hardFailed} failed, ${warnings} warned`);
  } else {
    lines.push(`${passed} passed, ${hardFailed} failed`);
  }
  return lines;
}

function computeExitCode(checks: Check[], strict: boolean): number {
  const hasHardFailure = checks.some((c) => !c.ok && !c.warn);
  const hasWarning = checks.some((c) => !c.ok && c.warn);
  return hasHardFailure || (strict && hasWarning) ? 1 : 0;
}

export interface ConnectivityProbes {
  readonly checkTelegramToken?: (token: string) => Promise<void>;
  readonly checkModelProvider?: (resolved: ResolvedModel) => Promise<void>;
  readonly checkEdgeTtsAvailable?: () => Promise<void>;
  readonly checkGroqAsrAvailable?: (apiKey: string) => Promise<void>;
  readonly checkExternalAgents?: (cfg: Config) => Promise<void>;
  readonly checkMcp?: (cfg: Config, home: string) => Promise<void>;
}

/**
 * Hermetic test seam for subprocess runs of the CLI: when
 * `GOBLIN_DOCTOR_PROBE_STUB=pass|fail` is set and no explicit probes were
 * injected, every connectivity probe resolves (pass) or rejects (fail)
 * without touching the network. Any other value is ignored.
 */
function stubProbes(mode: "pass" | "fail"): ConnectivityProbes {
  const fn = async (): Promise<void> => {
    if (mode === "fail") throw new Error(`stubbed probe failure (${mode})`);
  };
  return {
    checkTelegramToken: fn,
    checkModelProvider: fn,
    checkEdgeTtsAvailable: fn,
    checkGroqAsrAvailable: fn,
    checkExternalAgents: fn,
    checkMcp: fn,
  };
}

function resolveStubEnv(): "pass" | "fail" | null {
  const value = process.env.GOBLIN_DOCTOR_PROBE_STUB;
  return value === "pass" || value === "fail" ? value : null;
}

export interface DoctorResult {
  readonly checks: readonly Check[];
  readonly exitCode: number;
  readonly lines: readonly string[];
}

function buildProviderEndpoint(baseUrl: string): string {
  if (new RegExp("\\/v\\d+$", "i").test(baseUrl)) {
    return `${baseUrl}/models`;
  }
  return `${baseUrl}/v1/models`;
}

function modelProviderHeaders(resolved: ResolvedModel): Record<string, string> {
  if (resolved.model.api === "anthropic-messages") {
    return {
      "x-api-key": resolved.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${resolved.apiKey}` };
}

async function defaultCheckTelegramToken(token: string): Promise<void> {
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

async function defaultCheckModelProvider(resolved: ResolvedModel): Promise<void> {
  const endpoint = buildProviderEndpoint(resolved.model.baseUrl);
  const headers = modelProviderHeaders(resolved);
  const req = new Request(endpoint, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  let res: Response;
  try {
    res = await fetch(req);
  } catch (err) {
    throw new Error(`model provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`model provider returned ${res.status}: ${body}`);
  }
}

async function defaultCheckEdgeTtsAvailable(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["uvx", "edge-tts", "--version"],
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5_000,
  });
  const exitCode = (await proc.exited) as number | null;
  if (exitCode === 0) return;
  if (exitCode === null) {
    throw new Error("uvx edge-tts --version timed out");
  }
  throw new Error(`uvx edge-tts --version exited ${exitCode}`);
}

async function defaultCheckGroqAsrAvailable(apiKey: string): Promise<void> {
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

async function defaultCheckExternalAgents(cfg: Config): Promise<void> {
  if (!cfg.externalAgents || cfg.externalAgents.backends.length === 0) return;
  const errors: string[] = [];
  for (const backend of cfg.externalAgents.backends) {
    try {
      const proc = Bun.spawn({
        cmd: [backend, "--version"],
        env: prepareEnv(),
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5_000,
      });
      const exitCode = (await proc.exited) as number | null;
      if (exitCode === 0) continue;
      if (exitCode === null) {
        throw new Error(`${backend} --version timed out`);
      }
      throw new Error(`${backend} --version exited ${exitCode}`);
    } catch (err) {
      errors.push(`${backend}: ${errorMessage(err)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

async function defaultCheckMcp(cfg: Config, home: string): Promise<void> {
  if (!cfg.mcp) return;
  const cmd = ["bunx", "--silent", "mcporter", "--log-level", "error"];
  const configPath = resolveMcporterConfigPath(cfg.mcp.configPath, home);
  if (configPath) {
    cmd.push("--config", configPath);
  }
  cmd.push("list", "--json");
  const proc = Bun.spawn({
    cmd,
    env: prepareMcpEnv(home),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  const exitCode = (await proc.exited) as number | null;
  const stderr = await new Response(proc.stderr).text();
  if (exitCode === null) {
    throw new Error(`MCP server list timed out: ${stderr.trim()}`);
  }
  if (exitCode !== 0) {
    throw new Error(`mcporter list failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
}

async function runProbe(name: string, fn: () => Promise<void>): Promise<Check> {
  try {
    await fn();
    return { name, ok: true, detail: "reachable" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timed?\s*out|timeout/i.test(message);
    return { name, ok: false, warn: true, timedOut, detail: message };
  }
}

async function runConnectivityChecks(
  home: string,
  explicitProbes?: ConnectivityProbes,
): Promise<Check[]> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch {
    return [];
  }

  const stub = resolveStubEnv();
  const probes: ConnectivityProbes | undefined =
    explicitProbes ?? (stub !== null ? stubProbes(stub) : undefined);

  const promises: Promise<Check>[] = [];

  promises.push(
    runProbe("Telegram", () =>
      (probes?.checkTelegramToken ?? defaultCheckTelegramToken)(cfg.botToken),
    ),
  );

  promises.push(
    runProbe("model provider", async () => {
      const resolved = resolveModel(cfg);
      await (probes?.checkModelProvider ?? defaultCheckModelProvider)(resolved);
    }),
  );

  promises.push(
    runProbe("Edge TTS", () =>
      (probes?.checkEdgeTtsAvailable ?? defaultCheckEdgeTtsAvailable)(),
    ),
  );

  if (cfg.groqApiKey) {
    const groqApiKey = cfg.groqApiKey;
    promises.push(
      runProbe("Groq ASR", () =>
        (probes?.checkGroqAsrAvailable ?? defaultCheckGroqAsrAvailable)(groqApiKey),
      ),
    );
  }

  if (cfg.externalAgents?.backends.length) {
    promises.push(
      runProbe("external agents", () =>
        (probes?.checkExternalAgents ?? defaultCheckExternalAgents)(cfg),
      ),
    );
  }

  if (cfg.mcp) {
    promises.push(
      runProbe("MCP servers", () =>
        (probes?.checkMcp ?? defaultCheckMcp)(cfg, home),
      ),
    );
  }

  return Promise.all(promises);
}

export async function runDoctor(options: { strict?: boolean; probes?: ConnectivityProbes } = {}): Promise<DoctorResult> {
  const home = goblinHome();
  const strict = options.strict ?? false;
  const local = await runChecks(home);
  const connectivity = await runConnectivityChecks(home, options.probes);
  const checks = [...local, ...connectivity];
  const lines = formatLines(checks, strict);
  const exitCode = computeExitCode(checks, strict);
  return { checks, exitCode, lines };
}

export async function main(): Promise<void> {
  const strict = process.argv.slice(2).includes("--strict");
  const { exitCode, lines } = await runDoctor({ strict });
  for (const line of lines) {
    out(line);
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("doctor failed:", { error: errorMessage(err) });
    out(`unexpected error: ${errorMessage(err)}`);
    process.exit(1);
  });
}
