/**
 * /debug diagnostics.
 *
 * Two layers:
 *   1. `gatherDiagnostics(deps)` collects what we can from the live runner,
 *      session, subagent runner, and the events.jsonl on disk.
 *   2. `formatDiagnostics(d)` turns the structured snapshot into the
 *      human-readable text we paste back into Telegram.
 *
 * Everything that we can't currently observe (skills loaded, context token
 * usage) is modelled as `null` and rendered as "unavailable" — present in
 * the output rather than silently omitted, per design.md.
 */

import { statSync, readFileSync } from "node:fs";
import type { SessionState } from "./sessions/types.ts";
import { eventsPath } from "./sessions/paths.ts";
import type { AgentRunner } from "./agent/mod.ts";
import type { SubagentRunner } from "./subagents/mod.ts";

/** Structured diagnostics snapshot. `null` fields are rendered "unavailable". */
export interface Diagnostics {
  sessionId: string;
  sessionName: string | null;
  createdAt: string;
  model: string;
  /** Tool names active on the live session. `null` if session not yet initialized. */
  tools: string[] | null;
  /** Number of skills loaded by pi. Currently always `null` — pi exposes no API for this. */
  skillsLoaded: number | null;
  /** Absolute path to the events.jsonl file. */
  eventsPath: string;
  /** Size of events.jsonl in bytes, or `null` if the file is missing/unreadable. */
  eventsBytes: number | null;
  /** Line count (excluding trailing empty line), or `null` if unreadable. */
  eventsLines: number | null;
  /** Number of currently-tracked subagents (any status, including completed/cancelled). */
  activeSubagents: number;
  /** Number of subagents whose status is "running". */
  runningSubagents: number;
  /** Approximate context tokens used. Currently always `null` — pi exposes no API for this. */
  contextTokens: number | null;
}

/** Inputs for `gatherDiagnostics`. */
export interface DiagnosticsDeps {
  session: SessionState;
  runner: AgentRunner | null;
  subagentRunner: SubagentRunner;
  goblinHome: string;
  /** Override for `Config.modelName` when no runner exists (e.g. session never primed). */
  modelName: string;
}

/**
 * Max file size to read into memory for line counting (10 MB).
 * Above this, we report size but skip line count to avoid blocking the event loop.
 */
const EVENTS_MAX_READ_BYTES = 10_000_000;

/**
 * Read the events.jsonl on disk and report size + line count.
 * Treats ENOENT (and any read error) as "unavailable" rather than throwing —
 * `/debug` is a diagnostics aid, not a critical path.
 * If the file exceeds {@link EVENTS_MAX_READ_BYTES}, lines is returned as `null`
 * to prevent blocking the event loop on a giant file.
 */
function readEventsStats(path: string): { bytes: number | null; lines: number | null } {
  try {
    const stat = statSync(path);
    if (stat.size > EVENTS_MAX_READ_BYTES) {
      return { bytes: stat.size, lines: null };
    }
    const raw = readFileSync(path, "utf-8");
    // events.jsonl is line-delimited JSON; trailing newline is conventional, so
    // filter empties to avoid an off-by-one on a freshly-created file.
    const lines = raw.split("\n").filter((l) => l.length > 0).length;
    return { bytes: stat.size, lines };
  } catch {
    return { bytes: null, lines: null };
  }
}

export function gatherDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const path = eventsPath(deps.goblinHome, deps.session.id);
  const { bytes, lines } = readEventsStats(path);
  const subagentList = deps.subagentRunner.list();

  return {
    sessionId: deps.session.id,
    sessionName: deps.session.title ?? null,
    createdAt: deps.session.createdAt,
    model: deps.runner?.modelName ?? deps.modelName,
    tools: deps.runner?.getActiveToolNames() ?? null,
    skillsLoaded: null,
    eventsPath: path,
    eventsBytes: bytes,
    eventsLines: lines,
    activeSubagents: subagentList.length,
    runningSubagents: subagentList.filter((s) => s.status === "running").length,
    contextTokens: null,
  };
}

const UNAVAILABLE = "unavailable";

function fmtTools(tools: string[] | null): string {
  if (tools === null) return UNAVAILABLE;
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

export function formatDiagnostics(d: Diagnostics): string {
  return [
    `Session: ${d.sessionId}`,
    `Session Name: ${d.sessionName ?? UNAVAILABLE}`,
    `Created: ${d.createdAt}`,
    `Model: ${d.model}`,
    `Tools: ${fmtTools(d.tools)}`,
    `Skills loaded: ${fmtNum(d.skillsLoaded)}`,
    `Events: ${d.eventsPath}`,
    `Events file: ${fmtBytes(d.eventsBytes)}, ${fmtNum(d.eventsLines)} lines`,
    `Subagents: ${d.activeSubagents} tracked, ${d.runningSubagents} running`,
    `Context: ${fmtNum(d.contextTokens)}`,
  ].join("\n");
}

/** Convenience: gather + format in one call. */
export function generateDiagnostics(deps: DiagnosticsDeps): string {
  return formatDiagnostics(gatherDiagnostics(deps));
}
