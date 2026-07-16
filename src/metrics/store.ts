import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { metricsPath } from "../sessions/paths.ts";

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

export type MetricsEvent = TurnMetricsEvent | CounterMetricsEvent | GenericMetricsEvent;

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

export class MetricsStore {
  private readonly path: string;

  constructor(home: string, sessionId: string) {
    this.path = metricsPath(home, sessionId);
  }

  record(event: MetricsEvent): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(event) + "\n";
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }

  incrementCounter(name: string, scope: string | null = null, delta: number = 1): void {
    const last = this.lastCounterValue(name, scope);
    this.record({ type: "counter", name, scope, value: last + delta });
  }

  private lastCounterValue(name: string, scope: string | null): number {
    const raw = readMetricsFile(this.path);
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
