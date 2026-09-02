#!/usr/bin/env bun

/**
 * Doctor CLI: read-only local system health checks for little-goblin.
 *
 * Usage:
 *   bun run doctor
 *   bun run src/doctor.ts
 */

import { accessSync, constants, lstatSync, readdirSync, statSync, statfsSync } from "node:fs";
import { loadConfig, requiredGoblinHomeDirectories, resolveGoblinHome } from "./config.ts";
import type { Config } from "./config.ts";
import { resolveModel } from "./agent/models.ts";
import type { ResolvedModel } from "./agent/models.ts";
import { ConversationStore } from "./sessions/conversation-store.ts";
import { isValidConversationId } from "./sessions/conversation.ts";
import {
  archivedStatePath,
  archiveDir,
  goblinConfigPath,
} from "./sessions/paths.ts";
import { memoryDbPath } from "./memory/paths.ts";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROVIDER, MemorySnapshot } from "./memory/db.ts";
import { MemoryBudget } from "./memory/budget.ts";
import { agentsMdPath, soulMdPath } from "./workspace/paths.ts";
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
  | { kind: "present"; isFile: boolean; isDirectory: boolean }
  | { kind: "missing" }
  | { kind: "error"; error: unknown };

/**
 * Stat a path and classify the outcome. Only ENOENT counts as "missing";
 * every other failure (EACCES, ELOOP, ...) is retained as an error so the
 * caller can surface the underlying problem instead of misreporting the
 * path as absent.
 */
function statPresence(path: string): PathPresence {
  try {
    const stats = statSync(path);
    return {
      kind: "present",
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "error", error: err };
  }
}

type PromptFilePresence =
  | { kind: "regular" }
  | { kind: "missing" }
  | { kind: "not-regular" }
  | { kind: "error"; operation: "stat" | "read"; error: unknown };

/**
 * Inspect a prompt file without collapsing bad filesystem states into absence.
 * A dangling symlink is not a true ENOENT: lstat can still see the link, so it
 * is reported as non-regular rather than as an optional missing file.
 */
function inspectPromptFile(path: string): PromptFilePresence {
  const presence = statPresence(path);
  if (presence.kind === "error") {
    return { kind: "error", operation: "stat", error: presence.error };
  }
  if (presence.kind === "missing") {
    try {
      lstatSync(path);
      return { kind: "not-regular" };
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "error", operation: "stat", error: err };
    }
  }
  if (!presence.isFile) {
    return { kind: "not-regular" };
  }
  try {
    accessSync(path, constants.R_OK);
    return { kind: "regular" };
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "error", operation: "read", error: err };
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
  const homePresence = statPresence(home);
  if (homePresence.kind === "missing") {
    return { name: "GOBLIN_HOME", ok: false, detail: `missing: ${home}` };
  }
  if (homePresence.kind === "error") {
    return {
      name: "GOBLIN_HOME",
      ok: false,
      detail: `cannot stat GOBLIN_HOME: ${errorMessage(homePresence.error)}`,
    };
  }
  if (!homePresence.isDirectory) {
    return { name: "GOBLIN_HOME", ok: false, detail: `not a directory: ${home}` };
  }

  const required = requiredGoblinHomeDirectories(home);
  const missing: string[] = [];
  for (const { label, path } of required) {
    const presence = statPresence(path);
    if (presence.kind === "missing") {
      missing.push(`${label} is missing`);
    } else if (presence.kind === "error") {
      missing.push(`${label}: ${errorMessage(presence.error)}`);
    } else if (!presence.isDirectory) {
      missing.push(`${label} is not a directory`);
    }
  }

  if (missing.length === 0) {
    return {
      name: "GOBLIN_HOME",
      ok: true,
      detail: `home exists at ${home}; subdirs: ${required.map(({ label }) => label).join(", ")}`,
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
  const soul = inspectPromptFile(soulMdPath(home));
  const agents = inspectPromptFile(agentsMdPath(home));

  for (const [label, presence] of [
    ["SOUL.md", soul],
    ["AGENTS.md", agents],
  ] as const) {
    if (presence.kind === "error") {
      return {
        name: "prompt files",
        ok: false,
        detail: `cannot ${presence.operation} ${label}: ${errorMessage(presence.error)}`,
      };
    }
  }

  // SOUL.md is mandatory at runtime (decision 0010: preflight throws on its
  // absence), and it must be a readable regular file when present.
  if (soul.kind === "missing") {
    const detail = agents.kind === "missing"
      ? "SOUL.md missing (critical); AGENTS.md missing"
      : "SOUL.md missing (critical)";
    return { name: "prompt files", ok: false, detail };
  }
  if (soul.kind === "not-regular") {
    return {
      name: "prompt files",
      ok: false,
      detail: "SOUL.md is not a regular readable file (critical)",
    };
  }

  if (agents.kind === "regular") {
    return {
      name: "prompt files",
      ok: true,
      detail: "SOUL.md and AGENTS.md present",
    };
  }
  if (agents.kind === "missing") {
    // Decision 0010 makes AGENTS.md optional. This is the only warning path:
    // bad file types and unreadable files remain critical diagnostics.
    return {
      name: "prompt files",
      ok: false,
      warn: true,
      detail: "AGENTS.md missing (optional per decision 0010)",
    };
  }
  return {
    name: "prompt files",
    ok: false,
    detail: "AGENTS.md is not a regular readable file (critical)",
  };
}

export interface DoctorDiskStats {
  readonly bsize: number;
  readonly blocks: number;
  readonly bavail: number;
}

/** Injectable boundary for deterministic local diagnostics tests. */
export interface DoctorDependencies {
  readonly statfs?: (path: string) => DoctorDiskStats;
}

async function checkDisk(
  home: string,
  statfs: (path: string) => DoctorDiskStats,
): Promise<Check> {
  try {
    const stats = statfs(home);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    if (stats.bavail <= 0) {
      return {
        name: "disk",
        ok: false,
        detail: `0 available blocks on ${home} (${formatBytes(free)} free / ${formatBytes(total)} total)`,
      };
    }
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

async function runChecks(home: string, dependencies: DoctorDependencies): Promise<Check[]> {
  return Promise.all([
    checkStateVersion(home),
    checkGoblinHomeDirs(home),
    checkMemory(home),
    checkConversations(home),
    checkConfig(),
    checkFavorites(),
    checkPromptFiles(home),
    checkDisk(home, dependencies.statfs ?? statfsSync),
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

/**
 * Injectable connectivity boundary for tests and embedded callers. Production
 * omits it and always executes the configured live probes.
 */
export interface ConnectivityProbes {
  readonly checkTelegramToken?: (token: string) => Promise<void>;
  readonly checkModelProvider?: (resolved: ResolvedModel) => Promise<void>;
  readonly checkEdgeTtsAvailable?: () => Promise<void>;
  readonly checkGroqAsrAvailable?: (apiKey: string) => Promise<void>;
  readonly checkExternalAgents?: (cfg: Config) => Promise<void>;
  readonly checkMcp?: (cfg: Config, home: string) => Promise<void>;
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

const MAX_PROCESS_PROBE_OUTPUT_CHARS = 8 * 1024;

interface CapturedProcessOutput {
  readonly text: string;
  readonly truncated: boolean;
}

interface OutputCollector {
  readonly completed: Promise<CapturedProcessOutput>;
  cancel(): Promise<void>;
}

function createOutputCollector(stream: ReadableStream<Uint8Array> | undefined): OutputCollector {
  if (stream === undefined) {
    return {
      completed: Promise.resolve({ text: "", truncated: false }),
      cancel: async () => {},
    };
  }

  const reader = stream.getReader();
  let canceled = false;
  const completed = (async (): Promise<CapturedProcessOutput> => {
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    const append = (chunk: string): void => {
      if (chunk.length === 0) return;
      const combined = text + chunk;
      if (combined.length > MAX_PROCESS_PROBE_OUTPUT_CHARS) {
        text = combined.slice(-MAX_PROCESS_PROBE_OUTPUT_CHARS);
        truncated = true;
      } else {
        text = combined;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
      append(decoder.decode());
    } catch (err) {
      if (!canceled) throw err;
    } finally {
      reader.releaseLock();
    }
    return { text, truncated };
  })();

  return {
    completed,
    cancel: async (): Promise<void> => {
      canceled = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already have closed or released its lock.
      }
    },
  };
}

function formatCapturedOutput(output: CapturedProcessOutput): string {
  const text = output.text.trim();
  if (text.length === 0) return "";
  return `${output.truncated ? "… [truncated] " : ""}${text}`;
}

function formatProcessOutput(
  stdout: CapturedProcessOutput,
  stderr: CapturedProcessOutput,
): string {
  const output: string[] = [];
  const stdoutText = formatCapturedOutput(stdout);
  if (stdoutText.length > 0) output.push(`stdout: ${stdoutText}`);
  const stderrText = formatCapturedOutput(stderr);
  if (stderrText.length > 0) output.push(`stderr: ${stderrText}`);
  return output.join("; ");
}

interface OwnedProbeProcess {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * A detached Bun subprocess leads its own POSIX process group. Signaling the
 * negative leader PID terminates only that owned group, including descendants,
 * and awaiting `exited` reaps the direct child before the probe returns.
 */
async function terminateOwnedProcessGroup(
  proc: OwnedProbeProcess,
  collectors: readonly OutputCollector[],
): Promise<void> {
  let groupSignaled = false;
  try {
    process.kill(-proc.pid, "SIGKILL");
    groupSignaled = true;
  } catch {
    // The group may already be gone, or the platform may not support group signals.
  }
  if (!groupSignaled) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The direct child may already be gone.
    }
  }
  await Promise.all([proc.exited, ...collectors.map((collector) => collector.cancel())]);
}

interface ProcessProbeOptions {
  readonly cmd: readonly string[];
  readonly env?: Record<string, string>;
  readonly timeout: number;
  readonly label: string;
  /** Capture bounded stdout and stderr for diagnostics on failure. */
  readonly captureOutput?: boolean;
}

interface ProcessProbeCompletion {
  readonly exitCode: number | null;
  readonly stdout: CapturedProcessOutput;
  readonly stderr: CapturedProcessOutput;
}

async function runProcessProbe(opts: ProcessProbeOptions): Promise<string> {
  const start = performance.now();
  const captureOutput = opts.captureOutput ?? false;
  const proc = Bun.spawn({
    cmd: [...opts.cmd],
    env: opts.env,
    stdin: "ignore",
    stdout: captureOutput ? "pipe" : "ignore",
    stderr: captureOutput ? "pipe" : "ignore",
    detached: true,
  });
  const stdout = createOutputCollector(
    captureOutput ? proc.stdout as ReadableStream<Uint8Array> : undefined,
  );
  const stderr = createOutputCollector(
    captureOutput ? proc.stderr as ReadableStream<Uint8Array> : undefined,
  );
  const collectors = [stdout, stderr] as const;
  const completed = Promise.all([
    proc.exited as Promise<number | null>,
    stdout.completed,
    stderr.completed,
  ]).then(([exitCode, capturedStdout, capturedStderr]): ProcessProbeCompletion => ({
    exitCode,
    stdout: capturedStdout,
    stderr: capturedStderr,
  }));

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, opts.timeout);
  });

  let outcome:
    | { readonly kind: "completed"; readonly result: ProcessProbeCompletion }
    | { readonly kind: "timed-out" };
  try {
    outcome = await Promise.race([
      completed.then((result) => ({ kind: "completed" as const, result })),
      deadline.then(() => ({ kind: "timed-out" as const })),
    ]);
  } catch (err) {
    await terminateOwnedProcessGroup(proc, collectors);
    await Promise.allSettled([completed]);
    throw err;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  if (outcome.kind === "timed-out") {
    await terminateOwnedProcessGroup(proc, collectors);
    const settled = (await Promise.allSettled([completed]))[0]!;
    const detail = settled.status === "fulfilled"
      ? formatProcessOutput(settled.value.stdout, settled.value.stderr)
      : "";
    throw new TimeoutError(
      `${opts.label} timed out after ${Math.round(performance.now() - start)}ms${detail ? `: ${detail}` : ""}`,
    );
  }

  const { exitCode, stdout: capturedStdout, stderr: capturedStderr } = outcome.result;
  const detail = formatProcessOutput(capturedStdout, capturedStderr);
  if (exitCode === 0) return detail;
  if (exitCode === null) {
    throw new TimeoutError(
      `${opts.label} timed out after ${Math.round(performance.now() - start)}ms${detail ? `: ${detail}` : ""}`,
    );
  }
  throw new Error(`${opts.label} exited ${exitCode}${detail ? `: ${detail}` : ""}`);
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
    captureOutput: true,
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

  const probes = explicitProbes;

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

export async function runDoctor(options: {
  strict?: boolean;
  probes?: ConnectivityProbes;
  dependencies?: DoctorDependencies;
} = {}): Promise<DoctorResult> {
  const home = goblinHome();
  const strict = options.strict ?? false;
  const local = await runChecks(home, options.dependencies ?? {});
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
