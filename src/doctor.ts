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
import { buildMcporterCommand } from "./mcp/runner.ts";

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

class TimeoutError extends Error {
  readonly timedOut = true;
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

/** Result of probing a path's existence without swallowing real errors. */
type PathPresence =
  | { kind: "present"; isFile: boolean }
  | { kind: "missing" }
  | { kind: "error"; error: unknown };

/**
 * Stat a path and classify the outcome. Only ENOENT counts as "missing";
 * every other failure (EACCES, ELOOP, ...) is retained as an error so the
 * caller can surface the underlying problem instead of misreporting the
 * path as absent (unit [L3]).
 */
function statPresence(path: string): PathPresence {
  try {
    return { kind: "present", isFile: statSync(path).isFile() };
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "error", error: err };
  }
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
    const presence = statPresence(path);
    if (presence.kind === "missing") {
      missing.push(`${label} is missing`);
    } else if (presence.kind === "error") {
      missing.push(`${label}: ${errorMessage(presence.error)}`);
    } else if (!presence.isFile && !presence.kind) {
      missing.push(`${label} is not a directory`);
    } else if (!statSync(path).isDirectory()) {
      missing.push(`${label} is not a directory`);
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
    const archiveErrors: string[] = [];
    try {
      for (const id of readdirSync(archive)) {
        if (!isValidConversationId(id)) continue;
        const presence = statPresence(archivedStatePath(home, id));
        if (presence.kind === "present" && presence.isFile) {
          archived++;
        } else if (presence.kind === "error") {
          archiveErrors.push(`${id}: ${errorMessage(presence.error)}`);
        }
        // A missing state file is not an error; the entry is skipped.
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

    if (archiveErrors.length > 0) {
      return {
        name: "conversations",
        ok: false,
        detail: `cannot read archived conversations: ${archiveErrors.join("; ")}`,
      };
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
  const soul = statPresence(soulMdPath(home));
  const agents = statPresence(agentsMdPath(home));

  // Non-ENOENT stat failures are retained with their underlying error
  // (unit [L3]); they are critical because the file's state is unknown.
  for (const [label, presence] of [
    ["SOUL.md", soul],
    ["AGENTS.md", agents],
  ] as const) {
    if (presence.kind === "error") {
      return {
        name: "prompt files",
        ok: false,
        detail: `cannot stat ${label}: ${errorMessage(presence.error)}`,
      };
    }
  }

  const soulPresent = soul.kind === "present" && soul.isFile;
  const agentsPresent = agents.kind === "present" && agents.isFile;

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
 * `GOBLIN_DOCTOR_PROBE_STUB=pass|fail|pass-except-mcp` is set and no explicit
 * probes were injected, connectivity probes resolve (pass), reject (fail), or
 * resolve except for the real MCP gateway probe (pass-except-mcp), without
 * touching the network. Any other value is ignored.
 */
function stubProbes(mode: "pass" | "fail" | "pass-except-mcp"): ConnectivityProbes {
  const fn = async (): Promise<void> => {
    if (mode === "fail") throw new Error(`stubbed probe failure (${mode})`);
  };
  return {
    checkTelegramToken: fn,
    checkModelProvider: fn,
    checkEdgeTtsAvailable: fn,
    checkGroqAsrAvailable: fn,
    checkExternalAgents: fn,
    ...(mode === "pass-except-mcp" ? {} : { checkMcp: fn }),
  };
}

function resolveStubEnv(): "pass" | "fail" | "pass-except-mcp" | null {
  const value = process.env.GOBLIN_DOCTOR_PROBE_STUB;
  return value === "pass" || value === "fail" || value === "pass-except-mcp" ? value : null;
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

async function runProcessProbe(opts: {
  cmd: readonly string[];
  env?: Record<string, string>;
  timeout: number;
  label: string;
  pipeStderr?: boolean;
}): Promise<string> {
  const start = performance.now();
  const proc = Bun.spawn({
    cmd: [...opts.cmd],
    env: opts.env,
    stdout: "ignore",
    stderr: opts.pipeStderr ? "pipe" : "ignore",
    timeout: opts.timeout,
  });

  const reader = opts.pipeStderr ? (proc.stderr as ReadableStream<Uint8Array>).getReader() : undefined;
  let stderr = "";
  let stderrReaderCanceled = false;

  const collectStderr = async (): Promise<string> => {
    if (!reader) return "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
    } catch {
      // Canceled by timeout below; stderr is partial but usable.
    }
    return stderr;
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may already be gone.
      }
      if (!stderrReaderCanceled && reader) {
        reader.cancel().then(() => { stderrReaderCanceled = true; }).catch(() => {});
      }
      reject(new TimeoutError(`${opts.label} timed out after ${Math.round(performance.now() - start)}ms`));
    }, opts.timeout);
  });

  try {
    const [exitCode] = await Promise.race([
      Promise.all([proc.exited as Promise<number | null>, collectStderr()]),
      timeoutPromise,
    ]);
    const elapsed = performance.now() - start;
    if (exitCode === 0) return stderr;
    if (exitCode === null || elapsed >= opts.timeout) {
      throw new TimeoutError(`${opts.label} timed out after ${Math.round(elapsed)}ms${stderr ? `: ${stderr.trim()}` : ""}`);
    }
    throw new Error(`${opts.label} exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
  } finally {
    if (reader && !stderrReaderCanceled) {
      reader.cancel().catch(() => {});
    }
  }
}

interface TimedResponse {
  ok: boolean;
  status: number;
  body: string;
}

async function fetchWithTimeout(
  label: string,
  input: string | Request,
  init: RequestInit = {},
): Promise<TimedResponse> {
  const controller = new AbortController();
  const start = performance.now();
  const deadline = start + 5_000;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${label} timed out after 5_000ms`));
    }, 5_000);
  });
  try {
    const res = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      timeout,
    ]);
    const body = await Promise.race([
      res.text(),
      new Promise<never>((_, reject) => {
        const remaining = Math.max(0, deadline - performance.now());
        setTimeout(() => {
          res.body?.cancel().catch(() => {});
          reject(new TimeoutError(`${label} timed out after 5_000ms`));
        }, remaining);
      }),
    ]);
    return { ok: res.ok, status: res.status, body };
  } finally {
    // If any pending fetch/body promise is still going, abort it.
    controller.abort();
  }
}

async function defaultCheckTelegramToken(token: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/getMe`;
  try {
    const res = await fetchWithTimeout("Telegram API", url);
    if (!res.ok) {
      throw new Error(`Telegram API returned ${res.status}: ${res.body}`);
    }
  } catch (err) {
    if (err instanceof TimeoutError) throw err;
    throw new Error(`Telegram API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function defaultCheckModelProvider(resolved: ResolvedModel): Promise<void> {
  const endpoint = buildProviderEndpoint(resolved.model.baseUrl);
  const headers = modelProviderHeaders(resolved);
  let res: TimedResponse;
  try {
    res = await fetchWithTimeout("model provider", endpoint, { method: "GET", headers });
  } catch (err) {
    if (err instanceof TimeoutError) throw err;
    throw new Error(`model provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`model provider returned ${res.status}: ${res.body}`);
  }
}

async function defaultCheckEdgeTtsAvailable(): Promise<void> {
  await runProcessProbe({
    cmd: ["uvx", "edge-tts", "--version"],
    timeout: 5_000,
    label: "uvx edge-tts --version",
  });
}

async function defaultCheckGroqAsrAvailable(apiKey: string): Promise<void> {
  const url = "https://api.groq.com/openai/v1/models";
  const headers = { Authorization: `Bearer ${apiKey}` };
  let res: TimedResponse;
  try {
    res = await fetchWithTimeout("Groq ASR", url, { headers });
  } catch (err) {
    if (err instanceof TimeoutError) throw err;
    throw new Error(`Groq ASR unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Groq ASR API returned HTTP ${res.status}: ${res.body}`);
  }
}

async function defaultCheckExternalAgents(cfg: Config): Promise<void> {
  if (!cfg.externalAgents || cfg.externalAgents.backends.length === 0) return;
  const probes = cfg.externalAgents.backends.map(async (backend) => {
    try {
      await runProcessProbe({
        cmd: [backend, "--version"],
        env: prepareEnv(),
        timeout: 5_000,
        label: `${backend} --version`,
      });
      return null;
    } catch (err) {
      return { text: `${backend}: ${errorMessage(err)}`, timeout: err instanceof TimeoutError };
    }
  });
  const results = await Promise.all(probes);
  const errors = results.filter((r): r is { text: string; timeout: boolean } => r !== null);
  const message = errors.map((e) => e.text).join("; ");
  if (errors.length > 0) {
    if (errors.some((e) => e.timeout)) throw new TimeoutError(message);
    throw new Error(message);
  }
}

async function defaultCheckMcp(cfg: Config, home: string): Promise<void> {
  if (!cfg.mcp) return;
  const configPath = resolveMcporterConfigPath(cfg.mcp.configPath, home);
  const cmd = buildMcporterCommand(["list", "--json", "--status", "--exit-code"], configPath);
  await runProcessProbe({
    cmd,
    env: prepareMcpEnv(home),
    timeout: 5_000,
    label: "mcporter list",
    pipeStderr: true,
  });
}

async function runProbe(name: string, fn: () => Promise<void>): Promise<Check> {
  try {
    await fn();
    return { name, ok: true, detail: "reachable" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof TimeoutError;
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
