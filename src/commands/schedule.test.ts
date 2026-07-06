import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeSchedule,
  parseScheduleArgs,
  buildScheduleDeps,
  NO_ACTIVE_SESSION_REPLY,
  SCHEDULE_USAGE_REPLY,
  HEARTBEAT_USAGE_REPLY,
  type ScheduleCommandDeps,
} from "./schedule.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import type { ChatLocator, SessionState } from "../sessions/types.ts";
import type { ScheduledTurn } from "../scheduler/types.ts";

const NOW = Date.parse("2026-07-04T12:00:00Z");
const LOC: ChatLocator = { chatId: 100, topicId: 5 };
const FUTURE_ISO = "2026-07-05T09:00:00Z";

function makeSession(id = "sess-a"): SessionState {
  return {
    id,
    createdAt: "2026-07-01T00:00:00Z",
    chatId: 100,
    topicId: 5,
  };
}

/**
 * In-memory fake deps for pure `executeSchedule` tests. Records every call so
 * tests can assert behavior without touching the filesystem.
 */
function makeFakeDeps(session: SessionState | null = makeSession()): ScheduleCommandDeps & {
  created: { kind: "once" | "recurring"; prompt: string; nextRunAt: string; intervalMs?: number }[];
  removed: string[];
  paused: string[];
  resumed: string[];
  heartbeatCalls: { enabled: boolean; intervalMs?: number }[];
  listReturn: ScheduledTurn[];
  heartbeatReturn: ScheduledTurn | null;
} {
  return {
    hasSession: session !== null,
    session,
    locator: LOC,
    now: NOW,
    created: [],
    removed: [],
    paused: [],
    resumed: [],
    heartbeatCalls: [],
    listReturn: [],
    heartbeatReturn: null,
    create(params) {
      this.created.push(params);
      return {
        id: "newid1",
        sessionId: session?.id ?? "?",
        locator: LOC,
        kind: params.kind,
        prompt: params.prompt,
        enabled: true,
        state: "enabled",
        nextRunAt: params.nextRunAt,
        intervalMs: params.intervalMs,
        createdAt: "2026-07-04T12:00:00Z",
      };
    },
    list() {
      return this.listReturn;
    },
    remove(id) {
      this.removed.push(id);
      return true;
    },
    pause(id) {
      this.paused.push(id);
      return null;
    },
    resume(id) {
      this.resumed.push(id);
      return null;
    },
    setHeartbeat(params) {
      this.heartbeatCalls.push({ enabled: params.enabled, intervalMs: params.intervalMs });
      return {
        id: "hb1",
        sessionId: session?.id ?? "?",
        locator: LOC,
        kind: "heartbeat" as const,
        prompt: null,
        enabled: params.enabled,
        state: params.enabled ? ("enabled" as const) : ("disabled" as const),
        nextRunAt: "2026-07-04T12:30:00.000Z",
        intervalMs: params.intervalMs ?? 1800000,
        createdAt: "2026-07-04T12:00:00Z",
      };
    },
    getHeartbeat() {
      return this.heartbeatReturn;
    },
  } as ScheduleCommandDeps & {
    created: { kind: "once" | "recurring"; prompt: string; nextRunAt: string; intervalMs?: number }[];
    removed: string[];
    paused: string[];
    resumed: string[];
    heartbeatCalls: { enabled: boolean; intervalMs?: number }[];
    listReturn: ScheduledTurn[];
    heartbeatReturn: ScheduledTurn | null;
  };
}

describe("parseScheduleArgs", () => {
  it("returns null for bare /schedule", () => {
    expect(parseScheduleArgs("/schedule")).toBeNull();
    expect(parseScheduleArgs("/schedule@bot")).toBeNull();
  });

  it("extracts a bare subcommand with no rest", () => {
    expect(parseScheduleArgs("/schedule list")).toEqual({ sub: "list", rest: "" });
    expect(parseScheduleArgs("/schedule@bot list")).toEqual({ sub: "list", rest: "" });
  });

  it("extracts subcommand and rest", () => {
    expect(parseScheduleArgs("/schedule at 2026-07-05T09:00:00Z hello")).toEqual({
      sub: "at",
      rest: "2026-07-05T09:00:00Z hello",
    });
  });
});

describe("executeSchedule — active session requirement", () => {
  it("replies with no-active-session when there is no session", () => {
    const deps = makeFakeDeps(null);
    expect(executeSchedule(deps, "/schedule list").reply).toBe(NO_ACTIVE_SESSION_REPLY);
    expect(executeSchedule(deps, "/schedule list").tag).toBe("info");
    expect(executeSchedule(deps, "/schedule every 1h hello").reply).toBe(NO_ACTIVE_SESSION_REPLY);
  });

  it("returns usage when no subcommand is given", () => {
    const deps = makeFakeDeps();
    expect(executeSchedule(deps, "/schedule").reply).toBe(SCHEDULE_USAGE_REPLY);
    expect(executeSchedule(deps, "/schedule").tag).toBe("info");
  });
});

describe("executeSchedule — list", () => {
  it("reports no schedules when empty", () => {
    const deps = makeFakeDeps();
    expect(executeSchedule(deps, "/schedule list").reply).toBe("No schedules for this session.");
  });

  it("lists schedules with id, state, recurrence, next run, and preview", () => {
    const deps = makeFakeDeps();
    deps.listReturn = [
      {
        id: "abc123",
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "check backups",
        enabled: true,
        state: "enabled",
        nextRunAt: "2026-07-04T13:00:00.000Z",
        intervalMs: 3600000,
        createdAt: "2026-07-04T12:00:00Z",
      },
      {
        id: "def456",
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "one and done",
        enabled: false,
        state: "completed",
        nextRunAt: "2026-07-04T11:00:00.000Z",
        createdAt: "2026-07-04T12:00:00Z",
      },
    ];
    const reply = executeSchedule(deps, "/schedule list").reply;
    expect(reply).toContain("abc123");
    expect(reply).toContain("[enabled]");
    expect(reply).toContain("every 1h");
    expect(reply).toContain("check backups");
    // Completed one-shot shows "completed" as next run label.
    expect(reply).toContain("[completed]");
    // Non-heartbeat schedules show their prompt text, not the [heartbeat] tag.
    expect(reply).not.toContain("[heartbeat]");
  });

  it("renders heartbeat schedules with [heartbeat] preview", () => {
    const deps = makeFakeDeps();
    deps.listReturn = [
      {
        id: "hb1",
        sessionId: "sess-a",
        locator: LOC,
        kind: "heartbeat",
        prompt: null,
        enabled: true,
        state: "enabled",
        nextRunAt: "2026-07-04T12:30:00.000Z",
        intervalMs: 1800000,
        createdAt: "2026-07-04T12:00:00Z",
      },
    ];
    const reply = executeSchedule(deps, "/schedule list").reply;
    expect(reply).toContain("[heartbeat]");
    expect(reply).toContain("heartbeat 30m");
  });
});

describe("executeSchedule — at (one-shot absolute)", () => {
  it("creates an enabled one-shot and replies with id and run time", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, `/schedule at ${FUTURE_ISO} check the backup status`);
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]!.kind).toBe("once");
    expect(deps.created[0]!.prompt).toBe("check the backup status");
    expect(deps.created[0]!.nextRunAt).toBe(new Date(Date.parse(FUTURE_ISO)).toISOString());
    expect(result.reply).toContain("newid1");
    expect(result.reply).toContain("check the backup status");
    expect(result.tag).toBe("ok");
  });

  it("rejects a past timestamp", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule at 2000-01-01T00:00:00Z check backups");
    expect(result.reply).toBe("That time is in the past.");
    expect(result.tag).toBe("warn");
    expect(deps.created).toHaveLength(0);
  });

  it("rejects an invalid ISO timestamp with usage", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule at not-a-timestamp check backups");
    expect(result.reply).toBe(SCHEDULE_USAGE_REPLY);
    expect(result.tag).toBe("info");
    expect(deps.created).toHaveLength(0);
  });

  it("rejects a missing prompt", () => {
    const deps = makeFakeDeps();
    expect(executeSchedule(deps, `/schedule at ${FUTURE_ISO}`).reply).toBe(SCHEDULE_USAGE_REPLY);
    expect(deps.created).toHaveLength(0);
  });
});

describe("executeSchedule — in (one-shot relative)", () => {
  it("creates a one-shot due ~30m from now", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule in 30m stretch your legs");
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]!.kind).toBe("once");
    expect(deps.created[0]!.nextRunAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
    expect(result.reply).toContain("in 30m");
    expect(result.reply).toContain("stretch your legs");
    expect(result.tag).toBe("ok");
  });

  it("rejects an invalid relative duration", () => {
    const deps = makeFakeDeps();
    expect(executeSchedule(deps, "/schedule in soon stretch your legs").reply).toBe(SCHEDULE_USAGE_REPLY);
    expect(deps.created).toHaveLength(0);
  });
});

describe("executeSchedule — every (recurring)", () => {
  it("creates a recurring schedule with the interval", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule every 2h check the backup status");
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]!.kind).toBe("recurring");
    expect(deps.created[0]!.intervalMs).toBe(2 * 3_600_000);
    expect(result.reply).toContain("every 2h");
    expect(result.tag).toBe("ok");
  });

  it("rejects an invalid duration", () => {
    const deps = makeFakeDeps();
    expect(executeSchedule(deps, "/schedule every soon check backups").reply).toBe(SCHEDULE_USAGE_REPLY);
    expect(deps.created).toHaveLength(0);
  });
});

describe("executeSchedule — remove / pause / resume", () => {
  it("remove confirms when found", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule remove abc123");
    expect(result.reply).toBe("Removed schedule `abc123`.");
    expect(result.tag).toBe("ok");
    expect(deps.removed).toEqual(["abc123"]);
  });

  it("remove reports no match when the store returns false", () => {
    const deps = makeFakeDeps();
    deps.remove = () => false;
    const result = executeSchedule(deps, "/schedule remove nope99");
    expect(result.reply).toBe("No matching schedule `nope99`.");
    expect(result.tag).toBe("warn");
  });

  it("pause reports no match when store returns null (missing or foreign-owned)", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule pause nope99");
    expect(result.reply).toBe("No matching schedule `nope99`.");
    expect(result.tag).toBe("warn");
  });

  it("resume reports no match when store returns null", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule resume nope99");
    expect(result.reply).toBe("No matching schedule `nope99`.");
    expect(result.tag).toBe("warn");
  });
});

describe("executeSchedule — heartbeat", () => {
  it("on without duration enables heartbeat with default 30m", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule heartbeat on");
    expect(deps.heartbeatCalls).toEqual([{ enabled: true, intervalMs: undefined }]);
    expect(result.reply).toContain("every 30m");
    expect(result.tag).toBe("ok");
  });

  it("on with a custom interval applies it", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule heartbeat on 2h");
    expect(deps.heartbeatCalls).toEqual([{ enabled: true, intervalMs: 7_200_000 }]);
    expect(result.reply).toContain("every 2h");
    expect(result.tag).toBe("ok");
  });

  it("on with an invalid interval returns usage", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule heartbeat on soon");
    expect(result.reply).toBe(HEARTBEAT_USAGE_REPLY);
    expect(result.tag).toBe("info");
    expect(deps.heartbeatCalls).toHaveLength(0);
  });

  it("off disables heartbeat", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule heartbeat off");
    expect(result.reply).toBe("Heartbeat disabled.");
    expect(result.tag).toBe("ok");
    expect(deps.heartbeatCalls).toEqual([{ enabled: false, intervalMs: undefined }]);
  });

  it("status reports disabled when no heartbeat exists", () => {
    const deps = makeFakeDeps();
    deps.heartbeatReturn = null;
    const result = executeSchedule(deps, "/schedule heartbeat status");
    expect(result.reply).toBe("Heartbeat is disabled.");
    expect(result.tag).toBe("info");
  });

  it("status reports enabled with interval and next run", () => {
    const deps = makeFakeDeps();
    deps.heartbeatReturn = {
      id: "hb1",
      sessionId: "sess-a",
      locator: LOC,
      kind: "heartbeat",
      prompt: null,
      enabled: true,
      state: "enabled",
      nextRunAt: "2026-07-04T12:30:00.000Z",
      intervalMs: 1800000,
      createdAt: "2026-07-04T12:00:00Z",
    };
    const result = executeSchedule(deps, "/schedule heartbeat status");
    expect(result.reply).toContain("Heartbeat is enabled");
    expect(result.reply).toContain("every 30m");
    expect(result.tag).toBe("info");
  });

  it("bare /schedule heartbeat shows status", () => {
    const deps = makeFakeDeps();
    deps.heartbeatReturn = null;
    const result = executeSchedule(deps, "/schedule heartbeat");
    expect(result.reply).toBe("Heartbeat is disabled.");
    expect(result.tag).toBe("info");
  });

  it("unknown heartbeat action returns usage", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule heartbeat bogus");
    expect(result.reply).toBe(HEARTBEAT_USAGE_REPLY);
    expect(result.tag).toBe("info");
  });
});

describe("executeSchedule — unknown subcommand", () => {
  it("returns full usage for an unknown sub", () => {
    const deps = makeFakeDeps();
    const result = executeSchedule(deps, "/schedule frobnicate");
    expect(result.reply).toBe(SCHEDULE_USAGE_REPLY);
    expect(result.tag).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// Integration: buildScheduleDeps against a real ScheduleStore proves the
// wiring from command → store, including ownership checks and persistence.
// ---------------------------------------------------------------------------

describe("buildScheduleDeps + ScheduleStore (integration)", () => {
  let tmpDir: string;
  let store: ScheduleStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-sched-cmd-"));
    store = new ScheduleStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a one-shot via the real store and lists it", () => {
    const session = makeSession();
    const deps = buildScheduleDeps(store, session, LOC, NOW);
    const result = executeSchedule(deps, `/schedule at ${FUTURE_ISO} hello`);
    expect(result.reply).toContain("Scheduled");
    const list = executeSchedule(deps, "/schedule list");
    expect(list.reply).toContain("hello");
  });

  it("ownership: remove returns no-match for a foreign-owned schedule", () => {
    // Create a schedule owned by session B.
    store.create({
      sessionId: "sess-b",
      locator: { chatId: 999 },
      kind: "once",
      prompt: "foreign",
      nextRunAt: FUTURE_ISO,
    });
    const sessionA = makeSession("sess-a");
    const deps = buildScheduleDeps(store, sessionA, LOC, NOW);
    const id = store.listBySession("sess-b")[0]!.id;
    expect(executeSchedule(deps, `/schedule remove ${id}`).reply).toBe(`No matching schedule \`${id}\`.`);
    // The foreign schedule is untouched.
    expect(store.listBySession("sess-b")).toHaveLength(1);
  });

  it("ownership: pause returns no-match for a foreign-owned schedule", () => {
    store.create({
      sessionId: "sess-b",
      locator: { chatId: 999 },
      kind: "once",
      prompt: "foreign",
      nextRunAt: FUTURE_ISO,
    });
    const sessionA = makeSession("sess-a");
    const deps = buildScheduleDeps(store, sessionA, LOC, NOW);
    const id = store.listBySession("sess-b")[0]!.id;
    expect(executeSchedule(deps, `/schedule pause ${id}`).reply).toBe(`No matching schedule \`${id}\`.`);
  });

  it("ownership: resume returns no-match for a foreign-owned schedule", () => {
    store.create({
      sessionId: "sess-b",
      locator: { chatId: 999 },
      kind: "once",
      prompt: "foreign",
      nextRunAt: FUTURE_ISO,
    });
    const sessionA = makeSession("sess-a");
    const deps = buildScheduleDeps(store, sessionA, LOC, NOW);
    const id = store.listBySession("sess-b")[0]!.id;
    expect(executeSchedule(deps, `/schedule resume ${id}`).reply).toBe(`No matching schedule \`${id}\`.`);
    // The foreign schedule is untouched.
    expect(store.listBySession("sess-b")).toHaveLength(1);
  });

  it("heartbeat on enables a real heartbeat record in the store", () => {
    const session = makeSession();
    const deps = buildScheduleDeps(store, session, LOC, NOW);
    executeSchedule(deps, "/schedule heartbeat on");
    const hb = store.getHeartbeat(session.id);
    expect(hb).not.toBeNull();
    expect(hb!.enabled).toBe(true);
    expect(hb!.intervalMs).toBe(1800000);
  });

  it("heartbeat bare on resets a custom interval to the default", () => {
    const session = makeSession();
    const deps = buildScheduleDeps(store, session, LOC, NOW);
    executeSchedule(deps, "/schedule heartbeat on 2h");
    executeSchedule(deps, "/schedule heartbeat on");
    const hb = store.getHeartbeat(session.id);
    expect(hb!.intervalMs).toBe(1800000);
  });
});
