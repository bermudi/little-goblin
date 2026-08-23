import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MetricsStore, readMetricsSummary, type TelegramMetricsEvent } from "./store.ts";

const VALID_ID = "abc123def0";

function metricsFilePath(home: string): string {
  return join(home, "state", "sessions", VALID_ID, "metrics.jsonl");
}

function makeUsage(overrides?: {
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costTotal?: number;
}): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
  return {
    input: 10,
    output: 5,
    cacheRead: overrides?.cacheRead ?? 100,
    cacheWrite: overrides?.cacheWrite ?? 50,
    totalTokens: overrides?.totalTokens ?? 15,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: overrides?.costTotal ?? 0.003,
    },
  };
}

function makeTurnEvent(overrides?: {
  turnStart?: string;
  turnEnd?: string;
  durationMs?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costTotal?: number;
}) {
  const usage = makeUsage(overrides);
  return {
    type: "turn" as const,
    turnStart: overrides?.turnStart ?? "2026-01-01T00:00:00.000Z",
    turnEnd: overrides?.turnEnd ?? "2026-01-01T00:00:01.000Z",
    durationMs: overrides?.durationMs ?? 1000,
    model: "poe/Claude-Sonnet-4.6",
    provider: "poe",
    api: "anthropic-messages",
    usage,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    toolCount: 2,
    toolErrorCount: 1,
    stopReason: "end_turn" as string | null,
    errorMessage: null,
  };
}

function assertWriteErrorPropagates(write: () => void): void {
  const writeErr = new Error("disk full") as NodeJS.ErrnoException;
  writeErr.code = "ENOSPC";
  const writeSpy = spyOn(fs, "writeSync").mockImplementation((): never => { throw writeErr; });

  let caught: unknown;
  try {
    write();
  } catch (e) {
    caught = e;
  } finally {
    writeSpy.mockRestore();
  }

  expect(caught).toBe(writeErr);
}

function assertShortWritePropagates(write: () => void, path: string, line: string): void {
  const expectedBytes = Buffer.from(line, "utf8");
  const written = expectedBytes.byteLength - 1;
  let writeCalls = 0;
  let appendedFd: number | null = null;
  let receivedCompleteBuffer = false;
  const writeSpy = spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]): number => {
    writeCalls++;
    appendedFd = typeof args[0] === "number" ? args[0] : null;
    const data = args[1];
    receivedCompleteBuffer = Buffer.isBuffer(data) && data.equals(expectedBytes);
    return written;
  }) as unknown as typeof fs.writeSync);

  let caught: unknown;
  try {
    write();
  } catch (error) {
    caught = error;
  } finally {
    writeSpy.mockRestore();
  }

  expect(writeCalls).toBe(1);
  expect(receivedCompleteBuffer).toBe(true);
  expect(appendedFd).not.toBeNull();
  expect(() => fs.fstatSync(appendedFd!)).toThrow();
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(
    `Short metrics append: path=${path} expected=${expectedBytes.byteLength} written=${written}`,
  );
}

describe("MetricsStore", () => {
  let tmp: string;
  let store: MetricsStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-metrics-"));
    store = new MetricsStore(tmp, VALID_ID);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("record", () => {
    it("creates metrics.jsonl on first write and contains valid JSONL", () => {
      store.record({ type: "counter", name: "test", scope: null, value: 1 });
      const raw = readFileSync(metricsFilePath(tmp), "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        type: "counter",
        name: "test",
        scope: null,
        value: 1,
      });
    });

    it("appends a second complete JSON line", () => {
      store.record({ type: "counter", name: "a", scope: null, value: 1 });
      store.record({ type: "counter", name: "b", scope: "general", value: 2 });
      const raw = readFileSync(metricsFilePath(tmp), "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]!)).toEqual({ type: "counter", name: "a", scope: null, value: 1 });
      expect(JSON.parse(lines[1]!)).toEqual({
        type: "counter",
        name: "b",
        scope: "general",
        value: 2,
      });
    });

    it("ignores a stale legacy lock artifact left by a crashed process", () => {
      const lockPath = `${metricsFilePath(tmp)}.lock`;
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "legacy crash artifact", "utf-8");
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockPath, stale, stale);

      store.record({ type: "counter", name: "test", scope: null, value: 1 });

      expect(readFileSync(lockPath, "utf-8")).toBe("legacy crash artifact");
      expect(JSON.parse(readFileSync(metricsFilePath(tmp), "utf-8").trim())).toEqual({
        type: "counter",
        name: "test",
        scope: null,
        value: 1,
      });
    });

    it("propagates append failures without creating a lock artifact", () => {
      assertWriteErrorPropagates(() => store.record({ type: "counter", name: "test", scope: null, value: 1 }));
      expect(fs.existsSync(`${metricsFilePath(tmp)}.lock`)).toBe(false);
    });

    it("fails with append context when one write reports a short byte count", () => {
      const event = { type: "counter" as const, name: "göblin 👺", scope: null, value: 1 };
      const line = JSON.stringify(event) + "\n";
      assertShortWritePropagates(() => store.record(event), metricsFilePath(tmp), line);
    });

    it("persists a turn event with nested usage", () => {
      store.record(makeTurnEvent());
      const summary = readMetricsSummary(tmp, VALID_ID);
      expect(summary).not.toBeNull();
      expect(summary!.turns).toBe(1);
      expect(summary!.totalTokens).toBe(15);
      expect(summary!.cacheRead).toBe(100);
      expect(summary!.cacheWrite).toBe(50);
      expect(summary!.totalCost).toBe(0.003);
      expect(summary!.lastTurn).not.toBeNull();
      expect(summary!.lastTurn!.usage.totalTokens).toBe(15);
      expect(summary!.averageDurationMs).toBe(1000);
    });
  });

  describe("incrementCounter", () => {
    it("starts at 1 from zero", () => {
      store.incrementCounter("memory_write_total", "all");
      const summary = readMetricsSummary(tmp, VALID_ID);
      expect(summary!.memoryWriteTotal).toBe(1);
    });

    it("serializes cumulative updates across store instances in one process", () => {
      const otherStore = new MetricsStore(tmp, VALID_ID);

      store.incrementCounter("memory_write_total", "all");
      otherStore.incrementCounter("memory_write_total", "all");
      store.incrementCounter("memory_write_total", "all");

      const events = readFileSync(metricsFilePath(tmp), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { value: number });
      expect(events.map((event) => event.value)).toEqual([1, 2, 3]);
      expect(readMetricsSummary(tmp, VALID_ID)!.memoryWriteTotal).toBe(3);
    });

    it("keeps scopes independent and aggregates by counter name", () => {
      store.incrementCounter("memory_write_overflow_total", "general");
      store.incrementCounter("memory_write_overflow_total", "general");
      store.incrementCounter("memory_write_overflow_total", "user");
      const summary = readMetricsSummary(tmp, VALID_ID);
      expect(summary!.memoryWriteOverflowTotal).toBe(3);
    });

    it("uses a default delta of 1 and a default null scope", () => {
      store.incrementCounter("manual_counter");
      const raw = readFileSync(metricsFilePath(tmp), "utf-8");
      const parsed = JSON.parse(raw.trim());
      expect(parsed).toEqual({ type: "counter", name: "manual_counter", scope: null, value: 1 });
    });

    it("propagates read-modify-append failures without creating a lock artifact", () => {
      assertWriteErrorPropagates(() => store.incrementCounter("manual_counter"));
      expect(fs.existsSync(`${metricsFilePath(tmp)}.lock`)).toBe(false);
    });

    it("propagates the short-write boundary failure", () => {
      const line = JSON.stringify({ type: "counter", name: "manual_counter", scope: null, value: 1 }) + "\n";
      assertShortWritePropagates(
        () => store.incrementCounter("manual_counter"),
        metricsFilePath(tmp),
        line,
      );
    });
  });

  describe("readMetricsSummary", () => {
    it("returns null when metrics.jsonl is missing", () => {
      expect(readMetricsSummary(tmp, "0000000000")).toBeNull();
    });

    it("skips malformed lines and still returns a summary", () => {
      store.record({ type: "counter", name: "memory_write_total", scope: "all", value: 4 });
      const path = metricsFilePath(tmp);
      const fd = openSync(path, "a");
      try {
        writeSync(fd, "this is not json\n");
      } finally {
        closeSync(fd);
      }
      const summary = readMetricsSummary(tmp, VALID_ID);
      expect(summary!.memoryWriteTotal).toBe(4);
    });

    it("aggregates a complete session picture", () => {
      store.record({ type: "counter", name: "memory_write_total", scope: "all", value: 5 });
      store.record({
        type: "counter",
        name: "memory_write_overflow_total",
        scope: "general",
        value: 2,
      });
      store.record(makeTurnEvent({ totalTokens: 30, cacheRead: 200, cacheWrite: 100, costTotal: 0.006 }));
      store.record({
        type: "event",
        name: "memory_search",
        scope: null,
        extra: { query: "deployment", resultCount: 3, limit: 10, scopes: 4 },
      });

      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.turns).toBe(1);
      expect(summary.totalTokens).toBe(30);
      expect(summary.cacheRead).toBe(200);
      expect(summary.cacheWrite).toBe(100);
      expect(summary.totalCost).toBe(0.006);
      expect(summary.memoryWriteTotal).toBe(5);
      expect(summary.memoryWriteOverflowTotal).toBe(2);
      expect(summary.searchCount).toBe(1);
      expect(summary.lastSearchResultCount).toBe(3);
      expect(summary.averageSearchResultCount).toBe(3);
    });

    it("returns the last turn and last search result count", () => {
      store.record(makeTurnEvent({ turnStart: "2026-01-01T00:00:00.000Z", turnEnd: "2026-01-01T00:00:01.000Z", durationMs: 1000 }));
      store.record({
        type: "event",
        name: "memory_search",
        scope: null,
        extra: { resultCount: 2 },
      });
      store.record(makeTurnEvent({ turnStart: "2026-01-01T00:00:02.000Z", turnEnd: "2026-01-01T00:00:04.000Z", durationMs: 2000 }));
      store.record({
        type: "event",
        name: "memory_search",
        scope: null,
        extra: { resultCount: 7 },
      });

      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.turns).toBe(2);
      expect(summary.lastTurn!.durationMs).toBe(2000);
      expect(summary.searchCount).toBe(2);
      expect(summary.lastSearchResultCount).toBe(7);
      expect(summary.averageSearchResultCount).toBe(4.5);
    });

    it("skips malformed turn events with missing usage", () => {
      store.record(makeTurnEvent({ totalTokens: 30, cacheRead: 200, cacheWrite: 100, costTotal: 0.006 }));
      const path = metricsFilePath(tmp);
      const fd = openSync(path, "a");
      try {
        writeSync(fd, JSON.stringify({ type: "turn" }) + "\n");
      } finally {
        closeSync(fd);
      }
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.turns).toBe(1);
      expect(summary.totalTokens).toBe(30);
      expect(summary.lastTurn!.usage.totalTokens).toBe(30);
    });

    it("skips malformed turn events with null usage", () => {
      store.record(makeTurnEvent({ totalTokens: 30, cacheRead: 200, cacheWrite: 100, costTotal: 0.006 }));
      const path = metricsFilePath(tmp);
      const fd = openSync(path, "a");
      try {
        writeSync(fd, JSON.stringify({ type: "turn", usage: null }) + "\n");
      } finally {
        closeSync(fd);
      }
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.turns).toBe(1);
      expect(summary.totalTokens).toBe(30);
    });

    it("defaults missing numeric turn fields to zero", () => {
      const path = metricsFilePath(tmp);
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "a");
      try {
        writeSync(
          fd,
          JSON.stringify({
            type: "turn",
            turnStart: "2026-01-01T00:00:00.000Z",
            turnEnd: "2026-01-01T00:00:01.000Z",
            usage: { totalTokens: 10 },
          }) + "\n",
        );
      } finally {
        closeSync(fd);
      }
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.turns).toBe(1);
      expect(summary.totalTokens).toBe(10);
      expect(summary.cacheRead).toBe(0);
      expect(summary.cacheWrite).toBe(0);
      expect(summary.totalCost).toBe(0);
      expect(summary.averageDurationMs).toBe(0);
    });

    it("skips malformed memory_search events with non-record extra", () => {
      store.record(makeTurnEvent({ totalTokens: 30 }));
      const path = metricsFilePath(tmp);
      const fd = openSync(path, "a");
      try {
        writeSync(fd, JSON.stringify({ type: "event", name: "memory_search", extra: null }) + "\n");
        writeSync(fd, JSON.stringify({ type: "event", name: "memory_search", extra: { resultCount: 5 } }) + "\n");
      } finally {
        closeSync(fd);
      }
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.searchCount).toBe(1);
      expect(summary.lastSearchResultCount).toBe(5);
    });
  });

  describe("telegram metrics", () => {
    it("persists a telegram event", () => {
      const event: TelegramMetricsEvent = {
        type: "telegram",
        op: "sendMessage",
        channel: "response",
        outcome: "success",
      };
      store.record(event);
      const raw = readFileSync(metricsFilePath(tmp), "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!)).toEqual(event);
    });

    it("returns zero telegram fields when no telegram events or counters exist", () => {
      store.record(makeTurnEvent());
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.telegram).toEqual({
        sendTotal: 0,
        sendSuccess: 0,
        sendError: 0,
        editTotal: 0,
        editSuccess: 0,
        editError: 0,
        messageNotModified: 0,
        messageGone: 0,
        throttled: 0,
        rateLimited: 0,
        topicNotFound: 0,
      });
    });

    it("aggregates mixed telegram events", () => {
      store.record({ type: "telegram", op: "sendMessage", channel: "status", outcome: "success" });
      store.record({ type: "telegram", op: "editMessageText", channel: "response", outcome: "error" });
      store.record({ type: "telegram", op: null, channel: "response", outcome: "throttled", elapsedMs: 100, throttleMs: 1100 });
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.telegram.sendTotal).toBe(1);
      expect(summary.telegram.sendSuccess).toBe(1);
      expect(summary.telegram.editTotal).toBe(1);
      expect(summary.telegram.editError).toBe(1);
      expect(summary.telegram.throttled).toBe(1);
    });

    it("uses counter-only telegram metrics", () => {
      store.incrementCounter("telegram_send_message_total", "response", 5);
      store.incrementCounter("telegram_send_message_success_total", "response", 4);
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.telegram.sendTotal).toBe(5);
      expect(summary.telegram.sendSuccess).toBe(4);
    });

    it("combines counters and events", () => {
      store.incrementCounter("telegram_send_message_success_total", null, 3);
      store.record({ type: "telegram", op: "sendMessage", channel: "response", outcome: "success" });
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.telegram.sendTotal).toBe(1);
      expect(summary.telegram.sendSuccess).toBe(4);
    });

    it("counts rate-limited and topic-not-found outcomes", () => {
      store.record({
        type: "telegram",
        op: "editMessageText",
        channel: "response",
        outcome: "rate_limited",
        retryAfterSec: 30,
      });
      store.record({
        type: "telegram",
        op: "editMessageText",
        channel: "response",
        outcome: "topic_not_found",
        errorCode: 400,
        errorDescription: "Topic not found",
      });
      store.incrementCounter("telegram_topic_not_found_total", null, 2);
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.telegram.editTotal).toBe(2);
      expect(summary.telegram.editError).toBe(2);
      expect(summary.telegram.rateLimited).toBe(1);
      expect(summary.telegram.topicNotFound).toBe(3);
    });

    it("counts message-gone and message-not-modified for edits", () => {
      store.record({ type: "telegram", op: "editMessageText", channel: "status", outcome: "message_not_modified" });
      store.record({
        type: "telegram",
        op: "editMessageText",
        channel: "response",
        outcome: "message_gone",
        errorCode: 400,
        errorDescription: "Message not found",
      });
      store.record({
        type: "telegram",
        op: "sendMessage",
        channel: "system",
        outcome: "message_gone",
        errorCode: 400,
        errorDescription: "Message not found",
      });
      const summary = readMetricsSummary(tmp, VALID_ID)!;
      expect(summary.telegram.editTotal).toBe(2);
      expect(summary.telegram.messageNotModified).toBe(1);
      expect(summary.telegram.messageGone).toBe(1);
      expect(summary.telegram.sendTotal).toBe(1);
      expect(summary.telegram.sendError).toBe(1);
    });
  });

  describe("session id validation", () => {
    it("rejects an invalid session id when constructing the store", () => {
      expect(() => new MetricsStore(tmp, "../etc/passwd")).toThrow(/Invalid session id/);
    });

    it("rejects an invalid session id when reading a summary", () => {
      expect(() => readMetricsSummary(tmp, "../etc/passwd")).toThrow(/Invalid session id/);
    });
  });
});
