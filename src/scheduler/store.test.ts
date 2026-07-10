import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScheduleStore, makeScheduleId, loadStore } from "./store.ts";
import { schedulesPath } from "../sessions/paths.ts";
import type { ChatLocator } from "../sessions/types.ts";
import type { ScheduledTurn } from "./types.ts";

const LOC: ChatLocator = { chatId: 100, topicId: 5 };
const OTHER_LOC: ChatLocator = { chatId: 200 };
const NOW_ISO = "2026-07-04T12:00:00Z";
const PAST_ISO = "2026-07-04T11:00:00Z";
const FUTURE_ISO = "2026-07-04T13:00:00Z";

describe("ScheduleStore", () => {
  let tmpDir: string;
  let store: ScheduleStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-sched-"));
    store = new ScheduleStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("missing/malformed file", () => {
    it("loads as empty when the store file is missing", () => {
      expect(store.listBySession("any")).toEqual([]);
      expect(existsSync(schedulesPath(tmpDir))).toBe(false);
    });

    it("warns and loads empty on malformed JSON", () => {
      mkdirSync(dirname(schedulesPath(tmpDir)), { recursive: true });
      writeFileSync(schedulesPath(tmpDir), "{not json");
      const loaded = loadStore(tmpDir);
      expect(loaded.schedules).toEqual([]);
    });
  });

  describe("persistence", () => {
    it("persists a created one-shot schedule to disk via atomic write", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "check backups",
        nextRunAt: FUTURE_ISO,
      });

      const raw = readFileSync(schedulesPath(tmpDir), "utf-8");
      const file = JSON.parse(raw);
      expect(file.schedules).toHaveLength(1);
      expect(file.schedules[0]).toMatchObject({
        id: created.id,
        sessionId: "sess-a",
        kind: "once",
        prompt: "check backups",
        enabled: true,
        state: "enabled",
        nextRunAt: FUTURE_ISO,
        locator: { chatId: 100, topicId: 5 },
      });
    });

    it("reloads schedules from disk in a new store instance", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "hello",
        nextRunAt: FUTURE_ISO,
      });
      const reopened = new ScheduleStore(tmpDir);
      expect(reopened.listBySession("sess-a").map((s) => s.id)).toEqual([created.id]);
    });
  });

  describe("makeScheduleId", () => {
    it("returns 10 hex chars", () => {
      const id = makeScheduleId();
      expect(id).toHaveLength(10);
      expect(id).toMatch(/^[0-9a-f]{10}$/);
    });

    it("create assigns ids matching the makeScheduleId shape", () => {
      const created = store.create({
        sessionId: "s",
        locator: LOC,
        kind: "once",
        prompt: "x",
        nextRunAt: FUTURE_ISO,
      });
      expect(created.id).toMatch(/^[0-9a-f]{10}$/);
    });
  });

  describe("one-shot records", () => {
    it("creates an enabled one-shot with the captured locator and prompt", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "check backups",
        nextRunAt: FUTURE_ISO,
      });
      expect(created.kind).toBe("once");
      expect(created.enabled).toBe(true);
      expect(created.prompt).toBe("check backups");
      expect(created.locator).toEqual(LOC);
      expect(created.intervalMs).toBeUndefined();
    });
  });

  describe("recurring records", () => {
    it("stores kind=recurring and the interval in ms", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "check backups",
        nextRunAt: FUTURE_ISO,
        intervalMs: 7_200_000,
      });
      expect(created.kind).toBe("recurring");
      expect(created.intervalMs).toBe(7_200_000);
    });
  });

  describe("ownership checks", () => {
    beforeEach(() => {
      store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "owned by a",
        nextRunAt: FUTURE_ISO,
      });
    });

    it("listBySession only returns the session's own schedules", () => {
      expect(store.listBySession("sess-a")).toHaveLength(1);
      expect(store.listBySession("sess-b")).toEqual([]);
    });

    it("getForSession returns null for an id owned by another session", () => {
      const aId = store.listBySession("sess-a")[0]!.id;
      expect(store.getForSession("sess-a", aId)).not.toBeNull();
      expect(store.getForSession("sess-b", aId)).toBeNull();
    });

    it("remove returns false for a foreign-owned schedule and does not modify it", () => {
      const aId = store.listBySession("sess-a")[0]!.id;
      expect(store.remove("sess-b", aId)).toBe(false);
      expect(store.listBySession("sess-a")).toHaveLength(1);
    });

    it("pause returns null for a foreign-owned schedule", () => {
      const aId = store.listBySession("sess-a")[0]!.id;
      expect(store.pause("sess-b", aId)).toBeNull();
      expect(store.listBySession("sess-a")[0]!.state).toBe("enabled");
    });

    it("resume returns null for a foreign-owned schedule", () => {
      const aId = store.listBySession("sess-a")[0]!.id;
      expect(store.resume("sess-b", aId)).toBeNull();
    });

    it("remove/pause/resume return null/false for a missing id", () => {
      expect(store.remove("sess-a", "nope99")).toBe(false);
      expect(store.pause("sess-a", "nope99")).toBeNull();
      expect(store.resume("sess-a", "nope99")).toBeNull();
    });
  });

  describe("pause / resume", () => {
    it("pause disables and resume re-enables without changing the prompt", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "check backups",
        nextRunAt: FUTURE_ISO,
      });
      const paused = store.pause("sess-a", created.id);
      expect(paused!.state).toBe("disabled");
      expect(paused!.enabled).toBe(false);
      expect(paused!.prompt).toBe("check backups");

      const resumed = store.resume("sess-a", created.id);
      expect(resumed!.state).toBe("enabled");
      expect(resumed!.enabled).toBe(true);
      expect(resumed!.prompt).toBe("check backups");
      expect(resumed!.nextRunAt).toBe(FUTURE_ISO);
    });

    it("resume on a completed one-shot keeps it completed", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "once",
        nextRunAt: PAST_ISO,
      });
      store.claimDue(created.id, NOW_ISO); // marks completed
      const resumed = store.resume("sess-a", created.id);
      expect(resumed!.state).toBe("completed");
      expect(resumed!.enabled).toBe(false);
    });

    it("pause on a completed one-shot keeps it completed (terminal-state guard)", () => {
      // A completed one-shot has run its single occurrence; `/schedule pause`
      // MUST NOT rewrite its terminal state to disabled — the list requirement
      // expects completed one-shots to display `completed`.
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "once",
        nextRunAt: PAST_ISO,
      });
      store.claimDue(created.id, NOW_ISO); // marks completed

      const paused = store.pause("sess-a", created.id);
      expect(paused!.state).toBe("completed");
      expect(paused!.enabled).toBe(false);
    });
  });

  describe("heartbeat defaults", () => {
    it("enabling heartbeat without an interval uses 30 minutes", () => {
      const hb = store.setHeartbeat({
        sessionId: "sess-a",
        locator: LOC,
        enabled: true,
        now: NOW_ISO,
      });
      expect(hb.kind).toBe("heartbeat");
      expect(hb.enabled).toBe(true);
      expect(hb.intervalMs).toBe(30 * 60 * 1000);
      expect(hb.prompt).toBeNull();
      // Next run is now + 30 min
      expect(hb.nextRunAt).toBe("2026-07-04T12:30:00.000Z");
    });

    it("enabling heartbeat with a custom interval applies it", () => {
      const hb = store.setHeartbeat({
        sessionId: "sess-a",
        locator: LOC,
        enabled: true,
        intervalMs: 2 * 60 * 60 * 1000,
        now: NOW_ISO,
      });
      expect(hb.intervalMs).toBe(7_200_000);
      expect(hb.nextRunAt).toBe("2026-07-04T14:00:00.000Z");
    });

    it("bare 'on' after a custom interval resets to 30 minutes", () => {
      store.setHeartbeat({
        sessionId: "sess-a",
        locator: LOC,
        enabled: true,
        intervalMs: 2 * 60 * 60 * 1000,
        now: NOW_ISO,
      });
      const reset = store.setHeartbeat({
        sessionId: "sess-a",
        locator: LOC,
        enabled: true,
        now: NOW_ISO,
      });
      expect(reset.intervalMs).toBe(30 * 60 * 1000);
    });

    it("getHeartbeat returns null when none exists", () => {
      expect(store.getHeartbeat("sess-a")).toBeNull();
    });

    it("disabling a non-existent heartbeat does not persist a record", () => {
      const hb = store.setHeartbeat({
        sessionId: "sess-a",
        locator: LOC,
        enabled: false,
        now: NOW_ISO,
      });
      expect(hb.enabled).toBe(false);
      // Nothing persisted
      expect(existsSync(schedulesPath(tmpDir))).toBe(false);
      expect(store.getHeartbeat("sess-a")).toBeNull();
    });

    it("disabling an enabled heartbeat keeps the record but disables it", () => {
      store.setHeartbeat({ sessionId: "sess-a", locator: LOC, enabled: true, now: NOW_ISO });
      const off = store.setHeartbeat({ sessionId: "sess-a", locator: LOC, enabled: false, now: NOW_ISO });
      expect(off.enabled).toBe(false);
      expect(off.state).toBe("disabled");
      // Record still on disk
      expect(store.getHeartbeat("sess-a")!.enabled).toBe(false);
    });
  });

  describe("due claiming", () => {
    it("listDue returns enabled schedules whose nextRunAt is in the past", () => {
      const due = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "due",
        nextRunAt: PAST_ISO,
      });
      store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "future",
        nextRunAt: FUTURE_ISO,
      });
      const list = store.listDue(NOW_ISO);
      expect(list.map((s) => s.id)).toEqual([due.id]);
    });

    it("listDue excludes disabled and completed schedules", () => {
      const a = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "a",
        nextRunAt: PAST_ISO,
      });
      store.pause("sess-a", a.id);
      expect(store.listDue(NOW_ISO)).toEqual([]);
    });

    it("claimDue marks a one-shot completed and disabled before dispatch", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "once",
        nextRunAt: PAST_ISO,
      });
      const claimed = store.claimDue(created.id, NOW_ISO);
      expect(claimed!.state).toBe("completed");
      expect(claimed!.enabled).toBe(false);
      // Second claim is a no-op
      expect(store.claimDue(created.id, NOW_ISO)).toBeNull();
    });

    it("claimDue advances a recurring schedule by its interval before dispatch", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "recur",
        nextRunAt: PAST_ISO,
        intervalMs: 60 * 60 * 1000,
      });
      const claimed = store.claimDue(created.id, NOW_ISO);
      // Past was 11:00, now 12:00, interval 1h → next 13:00
      expect(claimed!.nextRunAt).toBe("2026-07-04T13:00:00.000Z");
      expect(claimed!.state).toBe("enabled");
      // A later tick does not re-dispatch the same occurrence
      expect(store.claimDue(created.id, NOW_ISO)).toBeNull();
    });

    it("claimDue advances past multiple missed intervals without drift accumulation past now", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "recur",
        nextRunAt: "2026-07-04T09:00:00Z",
        intervalMs: 60 * 60 * 1000,
      });
      // now is 12:00; 9 + 3h = 12 (still due), advance to 13:00
      const claimed = store.claimDue(created.id, NOW_ISO);
      expect(claimed!.nextRunAt).toBe("2026-07-04T13:00:00.000Z");
    });

    it("claimDue on a future schedule returns null", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "future",
        nextRunAt: FUTURE_ISO,
      });
      expect(store.claimDue(created.id, NOW_ISO)).toBeNull();
    });

    it("two overlapping ticks claim the same occurrence at most once", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "once",
        nextRunAt: PAST_ISO,
      });
      const first = store.claimDue(created.id, NOW_ISO);
      const second = store.claimDue(created.id, NOW_ISO);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe("recordRun", () => {
    it("records last-run status and disables on binding-mismatch", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "x",
        nextRunAt: PAST_ISO,
        intervalMs: 60_000,
      });
      store.recordRun(created.id, { at: NOW_ISO, outcome: "binding-mismatch", message: "rebound" });
      const after = store.getForSession("sess-a", created.id);
      expect(after!.lastRun!.outcome).toBe("binding-mismatch");
      expect(after!.enabled).toBe(false);
      expect(after!.state).toBe("disabled");
    });

    it("records archived outcome and disables", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "x",
        nextRunAt: PAST_ISO,
        intervalMs: 60_000,
      });
      store.recordRun(created.id, { at: NOW_ISO, outcome: "archived" });
      const after = store.getForSession("sess-a", created.id);
      expect(after!.lastRun!.outcome).toBe("archived");
      expect(after!.enabled).toBe(false);
    });

    it("records ok outcome without disabling", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "recurring",
        prompt: "x",
        nextRunAt: PAST_ISO,
        intervalMs: 60_000,
      });
      store.claimDue(created.id, NOW_ISO);
      store.recordRun(created.id, { at: NOW_ISO, outcome: "ok" });
      const after = store.getForSession("sess-a", created.id);
      expect(after!.lastRun!.outcome).toBe("ok");
      expect(after!.enabled).toBe(true);
    });

    it("no-ops on a missing id", () => {
      expect(() => store.recordRun("nope", { at: NOW_ISO, outcome: "ok" })).not.toThrow();
    });

    it("preserves completed state when recording binding-mismatch on a one-shot", () => {
      // Terminal-state guard: a one-shot that was claimed (completed) and then
      // discovers a binding mismatch keeps `completed` — the occurrence ran.
      // The mismatch is recorded in lastRun as a diagnostic, not a lifecycle
      // transition.
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "once",
        nextRunAt: PAST_ISO,
      });
      store.claimDue(created.id, NOW_ISO); // marks completed
      store.recordRun(created.id, { at: NOW_ISO, outcome: "binding-mismatch" });

      const after = store.getForSession("sess-a", created.id);
      expect(after!.state).toBe("completed");
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("binding-mismatch");
    });

    it("preserves completed state when recording archived on a one-shot", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "once",
        nextRunAt: PAST_ISO,
      });
      store.claimDue(created.id, NOW_ISO); // marks completed
      store.recordRun(created.id, { at: NOW_ISO, outcome: "archived" });

      const after = store.getForSession("sess-a", created.id);
      expect(after!.state).toBe("completed");
      expect(after!.lastRun!.outcome).toBe("archived");
    });
  });

  describe("locator capture", () => {
    it("persists locator with chatId and topicId", () => {
      const created = store.create({
        sessionId: "sess-a",
        locator: OTHER_LOC,
        kind: "once",
        prompt: "x",
        nextRunAt: FUTURE_ISO,
      });
      expect(created.locator).toEqual({ chatId: 200 });
    });
  });

  describe("id generation / collision fallback", () => {
    it("returns the generated id when there is no collision", () => {
      const generated: string[] = [];
      const s = new ScheduleStore(tmpDir, () => {
        generated.push("aaaaaaaaaa");
        return "aaaaaaaaaa";
      });
      const created = s.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "x",
        nextRunAt: FUTURE_ISO,
      });
      expect(created.id).toBe("aaaaaaaaaa");
    });

    it("retries on collision and uses the first non-colliding id", () => {
      // First create seeds an existing id, then the second store's generator
      // returns the existing id once (collision) before yielding a fresh one.
      const seed = new ScheduleStore(tmpDir, () => "seedid0000");
      seed.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "first",
        nextRunAt: FUTURE_ISO,
      });

      let call = 0;
      const colliding = new ScheduleStore(tmpDir, () => {
        call++;
        return call === 1 ? "seedid0000" : "freshid001";
      });
      const created = colliding.create({
        sessionId: "sess-b",
        locator: LOC,
        kind: "once",
        prompt: "second",
        nextRunAt: FUTURE_ISO,
      });
      expect(created.id).toBe("freshid001");
      expect(call).toBe(2); // one collision, one success
    });

    it("falls back to a longer id after exhausting collision retries", () => {
      // Seed an existing id, then force the generator to always collide.
      const seed = new ScheduleStore(tmpDir, () => "seedid0000");
      seed.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "first",
        nextRunAt: FUTURE_ISO,
      });

      const alwaysCollide = new ScheduleStore(tmpDir, () => "seedid0000");
      const created = alwaysCollide.create({
        sessionId: "sess-b",
        locator: LOC,
        kind: "once",
        prompt: "second",
        nextRunAt: FUTURE_ISO,
      });
      // After 8 collisions the fallback yields a 16-char id (not the colliding
      // 10-char one), guaranteed unique against the seeded record.
      expect(created.id).toHaveLength(16);
      expect(created.id).not.toBe("seedid0000");
    });
  });

  describe("provenance", () => {
    it("create stamps user by default and agent when passed", () => {
      const user = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "u",
        nextRunAt: FUTURE_ISO,
      });
      expect(user.source).toBe("user");

      const agent = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "a",
        nextRunAt: FUTURE_ISO,
        source: "agent",
      });
      expect(agent.source).toBe("agent");
    });

    it("legacy records without source count as user", () => {
      mkdirSync(dirname(schedulesPath(tmpDir)), { recursive: true });
      writeFileSync(
        schedulesPath(tmpDir),
        JSON.stringify({
          schedules: [
            {
              id: "legacyid",
              sessionId: "sess-a",
              locator: LOC,
              kind: "once",
              prompt: "legacy",
              enabled: true,
              state: "enabled",
              nextRunAt: FUTURE_ISO,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      );
      expect(store.countEnabledAgentSchedules("sess-a")).toBe(0);
      expect(store.getForSession("sess-a", "legacyid")!.source).toBeUndefined();
    });

    it("countEnabledAgentSchedules counts only enabled agent-source records", () => {
      store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "a1",
        nextRunAt: FUTURE_ISO,
        source: "agent",
      });
      store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "a2",
        nextRunAt: FUTURE_ISO,
        source: "agent",
      });
      store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "u",
        nextRunAt: FUTURE_ISO,
      });
      const paused = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "a3",
        nextRunAt: FUTURE_ISO,
        source: "agent",
      });
      store.pause("sess-a", paused.id, true);

      expect(store.countEnabledAgentSchedules("sess-a")).toBe(2);
      expect(store.countEnabledAgentSchedules("sess-b")).toBe(0);
    });
  });

  describe("agent cap", () => {
    it("create refuses when the agent cap is exceeded", () => {
      for (let i = 0; i < 8; i++) {
        store.create({
          sessionId: "sess-a",
          locator: LOC,
          kind: "once",
          prompt: `a${i}`,
          nextRunAt: FUTURE_ISO,
          source: "agent",
        });
      }
      expect(store.countEnabledAgentSchedules("sess-a")).toBe(8);
      expect(() =>
        store.create({
          sessionId: "sess-a",
          locator: LOC,
          kind: "once",
          prompt: "too many",
          nextRunAt: FUTURE_ISO,
          source: "agent",
        }),
      ).toThrow(/cap/);
      expect(store.listBySession("sess-a")).toHaveLength(8);
    });

    it("pausing frees cap headroom for another agent create", () => {
      const created: ScheduledTurn[] = [];
      for (let i = 0; i < 8; i++) {
        created.push(
          store.create({
            sessionId: "sess-a",
            locator: LOC,
            kind: "once",
            prompt: `a${i}`,
            nextRunAt: FUTURE_ISO,
            source: "agent",
          }),
        );
      }
      store.pause("sess-a", created[0]!.id, true);
      expect(() =>
        store.create({
          sessionId: "sess-a",
          locator: LOC,
          kind: "once",
          prompt: "replacement",
          nextRunAt: FUTURE_ISO,
          source: "agent",
        }),
      ).not.toThrow();
      expect(store.countEnabledAgentSchedules("sess-a")).toBe(8);
    });

    it("resume at cap fails", () => {
      const created: ScheduledTurn[] = [];
      for (let i = 0; i < 8; i++) {
        created.push(
          store.create({
            sessionId: "sess-a",
            locator: LOC,
            kind: "once",
            prompt: `a${i}`,
            nextRunAt: FUTURE_ISO,
            source: "agent",
          }),
        );
      }
      store.pause("sess-a", created[0]!.id, true);
      store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "replacement",
        nextRunAt: FUTURE_ISO,
        source: "agent",
      });
      expect(() => store.resume("sess-a", created[0]!.id, true)).toThrow(/cap/);
      expect(store.getForSession("sess-a", created[0]!.id)!.state).toBe("disabled");
    });

    it("heartbeat on at cap fails", () => {
      for (let i = 0; i < 8; i++) {
        store.create({
          sessionId: "sess-a",
          locator: LOC,
          kind: "once",
          prompt: `a${i}`,
          nextRunAt: FUTURE_ISO,
          source: "agent",
        });
      }
      expect(() =>
        store.setHeartbeat({
          sessionId: "sess-a",
          locator: LOC,
          enabled: true,
          now: NOW_ISO,
          agent: true,
        }),
      ).toThrow(/cap/);
      expect(store.getHeartbeat("sess-a")).toBeNull();
    });

    it("user-source schedules are not capped", () => {
      for (let i = 0; i < 8; i++) {
        store.create({
          sessionId: "sess-a",
          locator: LOC,
          kind: "once",
          prompt: `a${i}`,
          nextRunAt: FUTURE_ISO,
          source: "agent",
        });
      }
      expect(() =>
        store.create({
          sessionId: "sess-a",
          locator: LOC,
          kind: "once",
          prompt: "user extra",
          nextRunAt: FUTURE_ISO,
          source: "user",
        }),
      ).not.toThrow();
      expect(store.listBySession("sess-a")).toHaveLength(9);
    });
  });

  describe("agent authority", () => {
    it("agent remove/pause/resume on a user-owned schedule fails", () => {
      const user = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "user",
        nextRunAt: FUTURE_ISO,
        source: "user",
      });
      expect(store.remove("sess-a", user.id, true)).toBe(false);
      expect(store.pause("sess-a", user.id, true)).toBeNull();
      expect(store.resume("sess-a", user.id, true)).toBeNull();
      expect(store.getForSession("sess-a", user.id)!.state).toBe("enabled");
    });

    it("user command remove/pause/resume on an agent-owned schedule succeeds", () => {
      const agent = store.create({
        sessionId: "sess-a",
        locator: LOC,
        kind: "once",
        prompt: "agent",
        nextRunAt: FUTURE_ISO,
        source: "agent",
      });
      expect(store.pause("sess-a", agent.id)).not.toBeNull();
      expect(store.resume("sess-a", agent.id)).not.toBeNull();
      expect(store.remove("sess-a", agent.id)).toBe(true);
      expect(store.getForSession("sess-a", agent.id)).toBeNull();
    });

    it("agent cannot turn off or overwrite a user-owned heartbeat", () => {
      store.setHeartbeat({
        sessionId: "sess-a",
        locator: LOC,
        enabled: true,
        now: NOW_ISO,
      });
      expect(() =>
        store.setHeartbeat({
          sessionId: "sess-a",
          locator: LOC,
          enabled: true,
          intervalMs: 60_000,
          now: NOW_ISO,
          agent: true,
        }),
      ).toThrow(/user-owned/);
      expect(() =>
        store.setHeartbeat({
          sessionId: "sess-a",
          locator: LOC,
          enabled: false,
          now: NOW_ISO,
          agent: true,
        }),
      ).toThrow(/user-owned/);
      expect(store.getHeartbeat("sess-a")!.enabled).toBe(true);
    });
  });
});
