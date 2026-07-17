import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { metricsPath } from "../sessions/paths.ts";

const LOCK_STALE_MS = 5000;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_RETRY_SLEEP_MS = 5;

/**
 * Acquire a file-scoped lock for the given metrics file using an atomic
 * `O_EXCL` lock file. The lock is released by the returned function.
 *
 * If a stale lock file is detected (older than `LOCK_STALE_MS`), it is removed
 * and acquisition is retried, so a crashed process does not block writers
 * forever. Contended locks are retried briefly before throwing.
 */
function lockMetricsFile(filePath: string): () => void {
  const lockPath = `${filePath}.lock`;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // ENOENT is expected if another writer already cleaned up.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Another writer holds the lock. Check for staleness and retry.
        try {
          const s = statSync(lockPath);
          if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Race: lock was released between check and stat; retry.
        }
        Bun.sleepSync(LOCK_RETRY_SLEEP_MS);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to acquire metrics lock for ${filePath}`);
}

export interface MetricsUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TurnMetricsEvent {
  type: "turn";
  turnStart: string;
  turnEnd: string;
  durationMs: number;
  model: string;
  provider: string;
  api: string;
  responseModel?: string;
  usage: MetricsUsage;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCount: number;
  toolErrorCount: number;
  stopReason: string | null;
  errorMessage: string | null;
}

export interface CounterMetricsEvent {
  type: "counter";
  name: string;
  scope: string | null;
  value: number;
}

export interface GenericMetricsEvent {
  type: "event";
  name: string;
  scope: string | null;
  extra: Record<string, unknown>;
}

export interface TelegramMetricsEvent {
  type: "telegram";
  op: "sendMessage" | "editMessageText" | null;
  channel: "status" | "response" | "system";
  outcome: "success" | "error" | "rate_limited" | "topic_not_found" | "message_gone" | "message_not_modified" | "throttled";
  errorCode?: number;
  errorDescription?: string;
  retryAfterSec?: number;
  elapsedMs?: number;
  throttleMs?: number;
}

export type MetricsEvent = TurnMetricsEvent | CounterMetricsEvent | GenericMetricsEvent | TelegramMetricsEvent;

export interface TelegramMetricsSummary {
  sendTotal: number;
  sendSuccess: number;
  sendError: number;
  editTotal: number;
  editSuccess: number;
  editError: number;
  messageNotModified: number;
  messageGone: number;
  throttled: number;
  rateLimited: number;
  topicNotFound: number;
}

export interface MetricsSummary {
  lastTurn: TurnMetricsEvent | null;
  turns: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  averageDurationMs: number;
  memoryWriteTotal: number;
  memoryWriteOverflowTotal: number;
  memoryWriteSafetyRejectTotal: number;
  memoryArchiveOrphanTotal: number;
  memoryReflectionCandidateTotal: number;
  memoryReflectionPersistedTotal: number;
  memoryReflectionQuarantineTotal: number;
  lastSearchResultCount: number | null;
  searchCount: number;
  averageSearchResultCount: number;
  telegram: TelegramMetricsSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return isNumber(value) ? value : 0;
}

function readMetricsFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseLines(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Skip malformed lines.
    }
  }
  return events;
}

function lastCounterValue(path: string, name: string, scope: string | null): number {
  const raw = readMetricsFile(path);
  if (raw === null) return 0;
  const events = parseLines(raw);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "counter" && event.name === name && event.scope === scope) {
      const value = event.value;
      if (typeof value === "number") return value;
    }
  }
  return 0;
}

export class MetricsStore {
  private readonly home: string;
  private readonly sessionId: string;

  constructor(home: string, sessionId: string) {
    this.home = home;
    this.sessionId = sessionId;
    // Validate eagerly; the absolute path is still re-resolved on every access.
    metricsPath(home, sessionId);
  }

  /** Re-resolve the metrics path on every access so archived/moved sessions do not leave a stale absolute path cached. */
  private get path(): string {
    return metricsPath(this.home, this.sessionId);
  }

  private writeLine(line: string): void {
    const path = this.path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      // Create the file with an empty body before appending the first line.
      const createFd = openSync(path, "a");
      closeSync(createFd);
    }
    const fd = openSync(path, "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }

  record(event: MetricsEvent): void {
    const release = lockMetricsFile(this.path);
    try {
      this.writeLine(JSON.stringify(event) + "\n");
    } finally {
      release();
    }
  }

  incrementCounter(name: string, scope: string | null = null, delta: number = 1): void {
    const path = this.path;
    const release = lockMetricsFile(path);
    try {
      const last = lastCounterValue(path, name, scope);
      this.writeLine(JSON.stringify({ type: "counter", name, scope, value: last + delta }) + "\n");
    } finally {
      release();
    }
  }
}

function getUsage(value: unknown): MetricsUsage | null {
  if (!isRecord(value)) return null;
  const cost = isRecord(value.cost) ? value.cost : {};
  return {
    input: getNumber(value, "input"),
    output: getNumber(value, "output"),
    cacheRead: getNumber(value, "cacheRead"),
    cacheWrite: getNumber(value, "cacheWrite"),
    totalTokens: getNumber(value, "totalTokens"),
    cost: {
      input: getNumber(cost, "input"),
      output: getNumber(cost, "output"),
      cacheRead: getNumber(cost, "cacheRead"),
      cacheWrite: getNumber(cost, "cacheWrite"),
      total: getNumber(cost, "total"),
    },
  };
}

function normalizeTurnEvent(event: Record<string, unknown>): TurnMetricsEvent | null {
  if (event.type !== "turn") return null;
  const usage = getUsage(event.usage);
  if (usage === null) return null;

  const stopReason = event.stopReason;
  const errorMessage = event.errorMessage;

  return {
    type: "turn",
    turnStart: typeof event.turnStart === "string" ? event.turnStart : "",
    turnEnd: typeof event.turnEnd === "string" ? event.turnEnd : "",
    durationMs: getNumber(event, "durationMs"),
    model: typeof event.model === "string" ? event.model : "",
    provider: typeof event.provider === "string" ? event.provider : "",
    api: typeof event.api === "string" ? event.api : "",
    responseModel: typeof event.responseModel === "string" ? event.responseModel : undefined,
    usage,
    cacheRead: getNumber(event, "cacheRead"),
    cacheWrite: getNumber(event, "cacheWrite"),
    cost: getNumber(event, "cost"),
    toolCount: getNumber(event, "toolCount"),
    toolErrorCount: getNumber(event, "toolErrorCount"),
    stopReason: typeof stopReason === "string" || stopReason === null ? stopReason : null,
    errorMessage: typeof errorMessage === "string" || errorMessage === null ? errorMessage : null,
  };
}

function getSearchResultCount(event: Record<string, unknown>): number | null {
  if (event.type !== "event" || event.name !== "memory_search") return null;
  const extra = event.extra;
  if (!isRecord(extra)) return null;
  return getNumber(extra, "resultCount");
}

function getLastCounters(events: Record<string, unknown>[]): Map<string, number> {
  const counters = new Map<string, number>();
  for (const event of events) {
    if (event.type === "counter" && typeof event.name === "string") {
      const scope = event.scope === null || typeof event.scope === "string" ? event.scope : null;
      counters.set(
        `${event.name}\x00${scope}`,
        typeof event.value === "number" ? event.value : 0,
      );
    }
  }
  return counters;
}

function counterTotal(counters: Map<string, number>, name: string): number {
  let total = 0;
  for (const [key, value] of counters) {
    const n = key.split("\x00")[0];
    if (n === name) total += value;
  }
  return total;
}

const TELEGRAM_OPS = ["sendMessage", "editMessageText"] as const;
type TelegramOp = (typeof TELEGRAM_OPS)[number];

const TELEGRAM_OUTCOMES = [
  "success",
  "error",
  "rate_limited",
  "topic_not_found",
  "message_gone",
  "message_not_modified",
  "throttled",
] as const;

function isTelegramOp(value: unknown): value is TelegramOp {
  return value === "sendMessage" || value === "editMessageText";
}

function isTelegramOutcome(value: unknown): value is (typeof TELEGRAM_OUTCOMES)[number] {
  return typeof value === "string" && (TELEGRAM_OUTCOMES as readonly string[]).includes(value);
}

function aggregateTelegramEvent(summary: TelegramMetricsSummary, event: Record<string, unknown>): void {
  if (!isTelegramOutcome(event.outcome)) return;
  const outcome = event.outcome;
  const op = event.op === null ? null : isTelegramOp(event.op) ? event.op : null;

  if (outcome === "throttled") {
    summary.throttled++;
    return;
  }
  if (outcome === "rate_limited") summary.rateLimited++;
  if (outcome === "topic_not_found") summary.topicNotFound++;

  if (op === "sendMessage") {
    summary.sendTotal++;
    if (outcome === "success") summary.sendSuccess++;
    else if (outcome === "error" || outcome === "rate_limited" || outcome === "topic_not_found" || outcome === "message_gone") summary.sendError++;
  } else if (op === "editMessageText") {
    summary.editTotal++;
    if (outcome === "success") summary.editSuccess++;
    else if (outcome === "error" || outcome === "rate_limited" || outcome === "topic_not_found" || outcome === "message_gone") summary.editError++;
    if (outcome === "message_not_modified") summary.messageNotModified++;
    if (outcome === "message_gone") summary.messageGone++;
  }
}

export function readMetricsSummary(home: string, sessionId: string): MetricsSummary | null {
  const raw = readMetricsFile(metricsPath(home, sessionId));
  if (raw === null) return null;

  const events = parseLines(raw);
  const counters = getLastCounters(events);

  const summary: MetricsSummary = {
    lastTurn: null,
    turns: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalCost: 0,
    averageDurationMs: 0,
    memoryWriteTotal: counterTotal(counters, "memory_write_total"),
    memoryWriteOverflowTotal: counterTotal(counters, "memory_write_overflow_total"),
    memoryWriteSafetyRejectTotal: counterTotal(counters, "memory_write_safety_reject_total"),
    memoryArchiveOrphanTotal: counterTotal(counters, "memory_archive_orphan_total"),
    memoryReflectionCandidateTotal: counterTotal(counters, "memory_reflection_candidate_total"),
    memoryReflectionPersistedTotal: counterTotal(counters, "memory_reflection_persisted_total"),
    memoryReflectionQuarantineTotal: counterTotal(counters, "memory_reflection_quarantine_total"),
    lastSearchResultCount: null,
    searchCount: 0,
    averageSearchResultCount: 0,
    telegram: {
      sendTotal: counterTotal(counters, "telegram_send_message_total"),
      sendSuccess: counterTotal(counters, "telegram_send_message_success_total"),
      sendError: counterTotal(counters, "telegram_send_message_error_total"),
      editTotal: counterTotal(counters, "telegram_edit_message_total"),
      editSuccess: counterTotal(counters, "telegram_edit_message_success_total"),
      editError: counterTotal(counters, "telegram_edit_message_error_total"),
      messageNotModified: 0,
      messageGone: 0,
      throttled: counterTotal(counters, "telegram_response_throttled_total"),
      rateLimited: 0,
      topicNotFound: counterTotal(counters, "telegram_topic_not_found_total"),
    },
  };

  let totalDuration = 0;
  let searchTotalResults = 0;

  for (const event of events) {
    switch (event.type) {
      case "turn": {
        const turn = normalizeTurnEvent(event);
        if (turn === null) break;
        summary.turns++;
        summary.totalTokens += turn.usage.totalTokens;
        summary.cacheRead += turn.cacheRead;
        summary.cacheWrite += turn.cacheWrite;
        summary.totalCost += turn.cost;
        summary.lastTurn = turn;
        totalDuration += turn.durationMs;
        break;
      }
      case "event": {
        const resultCount = getSearchResultCount(event);
        if (resultCount === null) break;
        summary.searchCount++;
        summary.lastSearchResultCount = resultCount;
        searchTotalResults += resultCount;
        break;
      }
      case "telegram": {
        aggregateTelegramEvent(summary.telegram, event);
        break;
      }
    }
  }

  if (summary.turns > 0) {
    summary.averageDurationMs = totalDuration / summary.turns;
  }
  if (summary.searchCount > 0) {
    summary.averageSearchResultCount = searchTotalResults / summary.searchCount;
  }

  return summary;
}
