/**
 * /debug diagnostics.
 *
 * Two layers:
 *   1. `gatherDiagnostics(deps)` collects what we can from the live runner,
 *      session, subagent runner, and the transcript.jsonl on disk.
 *   2. `formatDiagnostics(d)` turns the structured snapshot into the
 *      human-readable text we paste back into Telegram.
 *
 * Runner-backed fields (tools, skillsLoaded, contextTokens, contextFiles)
 * are `null` when the runner is absent OR when the runner exists but its
 * underlying pi `AgentSession` has not been initialized yet (the first
 * `prompt()` primes it lazily). `runnerInitialized` distinguishes the two
 * cases so `formatDiagnostics` can render "(not initialized — send a
 * message first)" instead of the misleading "unavailable".
 */

import { statSync, readFileSync } from "node:fs";
import type { SessionState } from "./sessions/types.ts";
import { transcriptPath } from "./sessions/paths.ts";
import type { AgentRunner } from "./agent/mod.ts";
import type { SubagentRunner } from "./subagents/mod.ts";
import { readMetricsSummary, type MetricsSummary } from "./metrics/mod.ts";

/** Structured diagnostics snapshot. `null` fields are rendered "unavailable". */
export interface Diagnostics {
  sessionId: string;
  sessionName: string | null;
  createdAt: string;
  model: string;
  /**
   * Whether the live runner's underlying pi `AgentSession` has been
   * initialized (i.e. at least one `prompt()` has run). `false` when
   * there is no runner OR the runner has not been primed yet. Drives the
   * "(not initialized)" rendering for runner-backed fields.
   */
  runnerInitialized: boolean;
  /** Tool names active on the live session. `null` if session not yet initialized. */
  tools: string[] | null;
  /** Number of skills loaded by pi. `null` if session not yet initialized. */
  skillsLoaded: number | null;
  /** Absolute path to the transcript.jsonl file. */
  transcriptPath: string;
  /** Size of transcript.jsonl in bytes, or `null` if the file is missing/unreadable. */
  transcriptBytes: number | null;
  /** Line count (excluding trailing empty line), or `null` if unreadable. */
  transcriptLines: number | null;
  /** Number of currently-tracked subagents (any status, including completed/cancelled). */
  activeSubagents: number;
  /** Number of subagents whose status is "running". */
  runningSubagents: number;
  /** Approximate context tokens used. `null` if session not yet initialized. */
  contextTokens: number | null;
  /** Paths of context files (AGENTS.md, skills) loaded into the session. `null` if uninitialized. */
  contextFiles: string[] | null;
  /** Bound project directory, or `null` if not set. */
  projectDir: string | null;
  /** Session metrics summary, or `null` if no metrics have been recorded. */
  metrics: MetricsSummary | null;
}

/** Inputs for `gatherDiagnostics`. */
export interface DiagnosticsDeps {
  session: SessionState;
  runner: AgentRunner | null;
  subagentRunner: SubagentRunner;
  goblinHome: string;
  /** Override for `Config.modelName` when no runner exists (e.g. session never primed). */
  modelName: string;
  /** Bound project directory, or `undefined` if not set. */
  projectDir?: string;
}

/**
 * Max file size to read into memory for line counting (10 MB).
 * Above this, we report size but skip line count to avoid blocking the event loop.
 */
const TRANSCRIPT_MAX_READ_BYTES = 10_000_000;

/**
 * Read the transcript.jsonl on disk and report size + line count.
 * Treats ENOENT (and any read error) as "unavailable" rather than throwing —
 * `/debug` is a diagnostics aid, not a critical path.
 * If the file exceeds {@link TRANSCRIPT_MAX_READ_BYTES}, lines is returned as `null`
 * to prevent blocking the event loop on a giant file.
 */
function readTranscriptStats(path: string): { bytes: number | null; lines: number | null } {
  try {
    const stat = statSync(path);
    if (stat.size > TRANSCRIPT_MAX_READ_BYTES) {
      return { bytes: stat.size, lines: null };
    }
    const raw = readFileSync(path, "utf-8");
    // transcript.jsonl is line-delimited JSON; trailing newline is conventional, so
    // filter empties to avoid an off-by-one on a freshly-created file.
    const lines = raw.split("\n").filter((l) => l.length > 0).length;
    return { bytes: stat.size, lines };
  } catch {
    return { bytes: null, lines: null };
  }
}

export function gatherDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const path = transcriptPath(deps.goblinHome, deps.session.id);
  const { bytes, lines } = readTranscriptStats(path);
  const subagentList = deps.subagentRunner.list();

  return {
    sessionId: deps.session.id,
    sessionName: deps.session.title ?? null,
    createdAt: deps.session.createdAt,
    model: deps.runner?.modelName ?? deps.modelName,
    runnerInitialized: deps.runner?.isInitialized ?? false,
    tools: deps.runner?.getActiveToolNames() ?? null,
    skillsLoaded: deps.runner?.skillsLoaded ?? null,
    transcriptPath: path,
    transcriptBytes: bytes,
    transcriptLines: lines,
    activeSubagents: subagentList.length,
    runningSubagents: subagentList.filter((s) => s.status === "running").length,
    contextTokens: deps.runner?.contextTokens ?? null,
    contextFiles: deps.runner?.contextFiles ?? null,
    projectDir: deps.projectDir ?? null,
    metrics: readMetricsSummary(deps.goblinHome, deps.session.id),
  };
}

const UNAVAILABLE = "unavailable";
/** Rendered for runner-backed fields when the runner's pi session hasn't been primed yet. */
const NOT_INITIALIZED = "(not initialized — send a message first)";

function fmtTools(tools: string[] | null, initialized: boolean): string {
  if (tools === null) return initialized ? UNAVAILABLE : NOT_INITIALIZED;
  if (tools.length === 0) return "(none)";
  return tools.join(", ");
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return UNAVAILABLE;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtNum(n: number | null): string {
  return n === null ? UNAVAILABLE : String(n);
}

/** Like `fmtNum` but distinguishes "not initialized" from genuine unavailability. */
function fmtRunnerNum(n: number | null, initialized: boolean): string {
  if (n === null) return initialized ? UNAVAILABLE : NOT_INITIALIZED;
  return String(n);
}

function fmtContextFiles(files: string[] | null, initialized: boolean): string {
  if (files === null) return initialized ? UNAVAILABLE : NOT_INITIALIZED;
  if (files.length === 0) return "(none)";
  return files.join(", ");
}

function fmtMetrics(metrics: MetricsSummary | null): string {
  if (metrics === null) {
    return `Metrics: ${UNAVAILABLE}`;
  }
  const tg = metrics.telegram;
  const lines = [
    `Metrics:`,
    `  Telegram sends: ${tg.sendTotal} (${tg.sendError} failed), edits: ${tg.editTotal} (${tg.editError} failed), throttled: ${tg.throttled}, rate-limited: ${tg.rateLimited}, topic not found: ${tg.topicNotFound}`,
    `  Turns: ${metrics.turns}`,
    `  Tokens: ${metrics.totalTokens}`,
    `  Cost: $ ${metrics.totalCost.toFixed(6)}`,
    `  Cache: ${metrics.cacheRead} read / ${metrics.cacheWrite} write tokens in this session`,
    `  Average duration: ${metrics.averageDurationMs.toFixed(0)} ms`,
    `  Memory writes: ${metrics.memoryWriteTotal} (overflow: ${metrics.memoryWriteOverflowTotal}, safety rejects: ${metrics.memoryWriteSafetyRejectTotal})`,
    `  Memory archives: ${metrics.memoryArchiveOrphanTotal}`,
    `  Reflection candidates: ${metrics.memoryReflectionCandidateTotal}, persisted: ${metrics.memoryReflectionPersistedTotal}, quarantined: ${metrics.memoryReflectionQuarantineTotal}`,
    `  Memory searches: ${metrics.searchCount} (last results: ${metrics.lastSearchResultCount ?? UNAVAILABLE}, average: ${metrics.averageSearchResultCount.toFixed(1)})`,
  ];
  if (metrics.lastTurn) {
    const turn = metrics.lastTurn;
    const error = turn.errorMessage ? `, error: ${turn.errorMessage}` : "";
    lines.push(
      `  Last turn: ${turn.model} (${turn.provider}/${turn.api}) — ${turn.usage.totalTokens} tokens, $ ${turn.cost.toFixed(6)}, cache ${turn.cacheRead}/${turn.cacheWrite}, stop: ${turn.stopReason ?? "none"}${error}, ${turn.toolCount} tools, ${turn.toolErrorCount} errors`,
    );
  }
  return lines.join("\n");
}

export function formatDiagnostics(d: Diagnostics): string {
  return [
    `Session: ${d.sessionId}`,
    `Session Name: ${d.sessionName ?? UNAVAILABLE}`,
    `Created: ${d.createdAt}`,
    `Model: ${d.model}`,
    `Tools: ${fmtTools(d.tools, d.runnerInitialized)}`,
    `Skills loaded: ${fmtRunnerNum(d.skillsLoaded, d.runnerInitialized)}`,
    `Transcript: ${d.transcriptPath}`,
    `Transcript file: ${fmtBytes(d.transcriptBytes)}, ${fmtNum(d.transcriptLines)} lines`,
    `Subagents: ${d.activeSubagents} tracked, ${d.runningSubagents} running`,
    `Context: ${fmtRunnerNum(d.contextTokens, d.runnerInitialized)}`,
    `Context files: ${fmtContextFiles(d.contextFiles, d.runnerInitialized)}`,
    `Project: ${d.projectDir !== null ? d.projectDir : "(none)"}`,
    fmtMetrics(d.metrics),
  ].join("\n");
}

/** Convenience: gather + format in one call. */
export function generateDiagnostics(deps: DiagnosticsDeps): string {
  return formatDiagnostics(gatherDiagnostics(deps));
}
