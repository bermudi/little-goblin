import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleTurnTool } from "./tool.ts";
import { ScheduleStore } from "./store.ts";
import { MAX_AGENT_SCHEDULES } from "./types.ts";
import type { ChatLocator } from "../sessions/types.ts";

const NOW_MS = new Date("2026-07-04T12:00:00.000Z").getTime();
const FUTURE_ISO = new Date(NOW_MS + 3600_000).toISOString();
const LOC: ChatLocator = { chatId: 1 };

function makeNow() {
  return () => NOW_MS;
}

async function run(tool: ReturnType<typeof createScheduleTurnTool>, action: string, extra: Record<string, unknown> = {}) {
  const result = await tool.execute("call-1", { action, ...extra } as any);
  return (result as any).details;
}

async function runThrows(tool: ReturnType<typeof createScheduleTurnTool>, action: string, extra: Record<string, unknown> = {}) {
  return expect(tool.execute("call-1", { action, ...extra } as any)).rejects;
}

describe("createScheduleTurnTool", () => {
  let tmpDir: string;
  let store: ScheduleStore;
  let tool: ReturnType<typeof createScheduleTurnTool>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-tool-test-"));
    store = new ScheduleStore(tmpDir);
    tool = createScheduleTurnTool({
      store,
      sessionId: "abcdef1234",
      locator: LOC,
      now: makeNow(),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create_once", () => {
    it("creates a one-shot with `in`", async () => {
      const result = await run(tool, "create_once", { in: "30m", prompt: "hello" });
      expect(result.kind).toBe("once");
      expect(result.source).toBe("agent");
      expect(result.nextRunAt).toBe(new Date(NOW_MS + 30 * 60_000).toISOString());
      expect(result.id).toBeString();
    });

    it("creates a one-shot with `at`", async () => {
      const result = await run(tool, "create_once", { at: FUTURE_ISO, prompt: "hello" });
      expect(result.kind).toBe("once");
      expect(result.nextRunAt).toBe(FUTURE_ISO);
    });

    it("rejects when both `in` and `at` are provided", async () => {
      await expect(
        tool.execute("call-1", { action: "create_once", in: "30m", at: FUTURE_ISO, prompt: "x" } as any),
      ).rejects.toThrow(/exactly one/);
    });

    it("rejects when neither `in` nor `at` is provided", async () => {
      await expect(tool.execute("call-1", { action: "create_once", prompt: "x" } as any)).rejects.toThrow(
        /requires one of/,
      );
    });

    it("rejects an empty prompt", async () => {
      await expect(
        tool.execute("call-1", { action: "create_once", in: "30m", prompt: "   " } as any),
      ).rejects.toThrow(/non-empty/);
    });

    it("rejects an invalid `in` duration", async () => {
      await expect(
        tool.execute("call-1", { action: "create_once", in: "7w", prompt: "x" } as any),
      ).rejects.toThrow(/Invalid duration/);
    });

    it("rejects a past `at` timestamp", async () => {
      await expect(
        tool.execute("call-1", { action: "create_once", at: "2020-01-01T00:00:00Z", prompt: "x" } as any),
      ).rejects.toThrow(/Invalid or past/);
    });
  });

  describe("create_recurring", () => {
    it("creates a recurring schedule", async () => {
      const result = await run(tool, "create_recurring", { every: "1h", prompt: "hourly" });
      expect(result.kind).toBe("recurring");
      expect(result.source).toBe("agent");
      expect(result.intervalMs).toBe(3600_000);
      expect(result.nextRunAt).toBe(new Date(NOW_MS + 3600_000).toISOString());
    });

    it("rejects an invalid duration", async () => {
      await expect(
        tool.execute("call-1", { action: "create_recurring", every: "7w", prompt: "x" } as any),
      ).rejects.toThrow(/Invalid duration/);
    });

    it("rejects a missing prompt", async () => {
      await expect(
        tool.execute("call-1", { action: "create_recurring", every: "1h" } as any),
      ).rejects.toThrow(/non-empty/);
    });
  });

  describe("list", () => {
    it("lists agent schedules with full prompts and redacts user schedules", async () => {
      const agent = await run(tool, "create_once", { in: "1h", prompt: "agent prompt" });
      const user = store.create({
        sessionId: "abcdef1234",
        locator: LOC,
        kind: "once",
        prompt: "user prompt",
        nextRunAt: FUTURE_ISO,
      });

      const result = await run(tool, "list");
      const records = result.schedules as Array<{ id: string; prompt: string | null; source: string; userOwned?: boolean }>;
      expect(records).toHaveLength(2);

      const agentRecord = records.find((r) => r.id === agent.id)!;
      expect(agentRecord.prompt).toBe("agent prompt");
      expect(agentRecord.source).toBe("agent");
      expect(agentRecord.userOwned).toBeUndefined();

      const userRecord = records.find((r) => r.id === user.id)!;
      expect(userRecord.prompt).toBeNull();
      expect(userRecord.source).toBe("user");
      expect(userRecord.userOwned).toBe(true);
    });
  });

  describe("remove / pause / resume", () => {
    it("remove deletes an agent-owned schedule", async () => {
      const created = await run(tool, "create_once", { in: "1h", prompt: "x" });
      const result = await run(tool, "remove", { id: created.id });
      expect(result.removed).toBe(true);
      expect(store.getForSession("abcdef1234", created.id)).toBeNull();
    });

    it("pause and resume an agent-owned schedule", async () => {
      const created = await run(tool, "create_once", { in: "1h", prompt: "x" });
      const paused = await run(tool, "pause", { id: created.id });
      expect(paused.state).toBe("disabled");
      const resumed = await run(tool, "resume", { id: created.id });
      expect(resumed.state).toBe("enabled");
    });

    it("rejects mutating a user-owned schedule", async () => {
      const user = store.create({
        sessionId: "abcdef1234",
        locator: LOC,
        kind: "once",
        prompt: "user-owned",
        nextRunAt: FUTURE_ISO,
      });
      await expect(tool.execute("call-1", { action: "remove", id: user.id } as any)).rejects.toThrow(/user-owned/);
      await expect(tool.execute("call-1", { action: "pause", id: user.id } as any)).rejects.toThrow(/user-owned/);
      await expect(tool.execute("call-1", { action: "resume", id: user.id } as any)).rejects.toThrow(/user-owned/);
    });
  });

  describe("heartbeat", () => {
    it("turns heartbeat on and off with default 30m", async () => {
      const on = await run(tool, "heartbeat", { heartbeat_action: "on" });
      expect(on.enabled).toBe(true);
      expect(on.intervalMs).toBe(30 * 60_000);
      expect(on.source).toBe("agent");

      const status = await run(tool, "heartbeat", { heartbeat_action: "status" });
      expect(status.enabled).toBe(true);
      expect(status.intervalMs).toBe(30 * 60_000);

      const off = await run(tool, "heartbeat", { heartbeat_action: "off" });
      expect(off.enabled).toBe(false);
      expect(off.source).toBe("agent");
    });

    it("accepts a custom duration for heartbeat on", async () => {
      const on = await run(tool, "heartbeat", { heartbeat_action: "on", duration: "2h" });
      expect(on.intervalMs).toBe(2 * 3600_000);
    });

    it("rejects turning on or off a user-owned heartbeat", async () => {
      store.setHeartbeat({
        sessionId: "abcdef1234",
        locator: LOC,
        enabled: true,
        now: new Date(NOW_MS).toISOString(),
      });
      await expect(
        tool.execute("call-1", { action: "heartbeat", heartbeat_action: "on", duration: "1h" } as any),
      ).rejects.toThrow(/user-owned/);
      await expect(
        tool.execute("call-1", { action: "heartbeat", heartbeat_action: "off" } as any),
      ).rejects.toThrow(/user-owned/);
    });
  });

  describe("agent cap", () => {
    it("create_recurring refuses when the cap is exceeded", async () => {
      for (let i = 0; i < MAX_AGENT_SCHEDULES; i++) {
        await run(tool, "create_once", { in: "1h", prompt: `a${i}` });
      }
      await expect(
        tool.execute("call-1", { action: "create_once", in: "1h", prompt: "too many" } as any),
      ).rejects.toThrow(/cap/);
    });

    it("heartbeat on refuses when the cap is exceeded", async () => {
      for (let i = 0; i < MAX_AGENT_SCHEDULES; i++) {
        await run(tool, "create_once", { in: "1h", prompt: `a${i}` });
      }
      await expect(
        tool.execute("call-1", { action: "heartbeat", heartbeat_action: "on" } as any),
      ).rejects.toThrow(/cap/);
    });
  });
});
