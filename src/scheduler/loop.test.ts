import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerLoop, HEARTBEAT_PROMPT, DEFAULT_TICK_INTERVAL_MS } from "./loop.ts";
import { ScheduleStore } from "./store.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { Config } from "../config.ts";
import type { ChatLocator } from "../sessions/types.ts";
import type { SessionState } from "../sessions/mod.ts";
import type { SchedulerClock, SchedulerDispatcher } from "./loop.ts";

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

/** Fake dispatcher that records every enqueueScheduledTurn call. */
function makeFakeDispatcher(): SchedulerDispatcher & {
  calls: { session: SessionState; locator: ChatLocator; content: string }[];
} {
  const calls: { session: SessionState; locator: ChatLocator; content: string }[] = [];
  return {
    calls,
    enqueueScheduledTurn(session, locator, content) {
      calls.push({ session, locator, content });
    },
  };
}

/** Controllable clock for deterministic ticks. */
function makeFakeClock(startMs: number): { clock: SchedulerClock; now: number; advance: (ms: number) => void } {
  const state = { now: startMs };
  return {
    clock: {
      now: () => state.now,
      // setInterval is not used by these tests (they call loop.tick()
      // directly), but provide a no-op implementation for completeness.
      setInterval: () => ({ clear: () => {} }),
    },
    get now() {
      return state.now;
    },
    advance: (ms) => {
      state.now += ms;
    },
  };
}

const NOW_MS = Date.parse("2026-07-04T12:00:00Z");

describe("SchedulerLoop", () => {
  let tmpDir: string;
  let manager: SessionManager;
  let store: ScheduleStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;
  let clock: ReturnType<typeof makeFakeClock>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-loop-test-"));
    manager = new SessionManager(makeTestConfig(tmpDir));
    manager.init();
    store = new ScheduleStore(tmpDir);
    dispatcher = makeFakeDispatcher();
    clock = makeFakeClock(NOW_MS);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeLoop(): SchedulerLoop {
    return new SchedulerLoop({ store, manager, dispatcher, clock: clock.clock });
  }

  describe("constants and prompt", () => {
    it("DEFAULT_TICK_INTERVAL_MS is 60000", () => {
      expect(DEFAULT_TICK_INTERVAL_MS).toBe(60_000);
    });

    it("HEARTBEAT_PROMPT is prefixed with [heartbeat]", () => {
      expect(HEARTBEAT_PROMPT.startsWith("[heartbeat]")).toBe(true);
    });

    it("HEARTBEAT_PROMPT does not claim a user asked a question", () => {
      expect(HEARTBEAT_PROMPT).toContain("No user message prompted this turn");
      expect(HEARTBEAT_PROMPT.toLowerCase()).not.toContain("you asked");
    });
  });

  describe("due dispatch", () => {
    it("dispatches a due schedule whose session is still bound", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "check backups",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.session.id).toBe(session.id);
      expect(dispatcher.calls[0]!.content).toBe("check backups");
      // One-shot is completed after dispatch.
      const after = store.getForSession(session.id, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.lastRun!.outcome).toBe("ok");
    });

    it("does not call AgentRunner.followUp (dispatches as a fresh turn)", async () => {
      // The fake dispatcher only exposes enqueueScheduledTurn; the loop MUST
      // route through it rather than any followUp path. Asserting the call
      // went through enqueueScheduledTurn (not a followUp field) is the proof.
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      await makeLoop().tick();

      // enqueueScheduledTurn is the only dispatch surface; followUp is never
      // invoked by the loop. The presence of exactly one enqueue call proves
      // the fresh-turn path.
      expect(dispatcher.calls).toHaveLength(1);
    });
  });

  describe("busy-session queueing", () => {
    it("dispatches via the shared dispatcher even when the prompt is synthetic", async () => {
      // The dispatcher (real TurnDispatcher) serializes through the per-
      // session queue; here we assert the loop hands the work to the
      // dispatcher and does not await prompt completion itself. The fake
      // dispatcher records the call synchronously and returns immediately.
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "recurring",
        prompt: "tick",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });

      const loop = makeLoop();
      await loop.tick();

      // The tick resolved before the prompt ran (fake dispatcher is sync),
      // proving the loop does not block on the dispatched turn.
      expect(dispatcher.calls).toHaveLength(1);
    });
  });

  describe("overlapping ticks", () => {
    it("does not double-dispatch the same due occurrence", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "once",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      // Two sequential ticks: the first claims + completes; the second finds
      // nothing due (the schedule is now completed).
      const loop = makeLoop();
      await loop.tick();
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(1);
    });

    it("re-entrant tick is a no-op while one is in flight", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "once",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      const loop = makeLoop();
      // Drive two ticks concurrently; the re-entrancy guard drops the second.
      await Promise.all([loop.tick(), loop.tick()]);

      expect(dispatcher.calls).toHaveLength(1);
    });
  });

  describe("one-shot completion", () => {
    it("marks a one-shot completed before dispatch and does not re-run it", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "once",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      await makeLoop().tick();

      const after = store.getForSession(session.id, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.enabled).toBe(false);
    });
  });

  describe("recurring advancement", () => {
    it("advances nextRunAt by the interval before dispatch", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: loc,
        kind: "recurring",
        prompt: "recur",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });

      await makeLoop().tick();

      const after = store.getForSession(session.id, created.id);
      expect(after!.state).toBe("enabled");
      // Advanced by 1h past the due time; not re-due at the same now.
      expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(NOW_MS);
    });

    it("does not dispatch the same occurrence again on a later tick", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "recurring",
        prompt: "recur",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });

      const loop = makeLoop();
      await loop.tick();
      await loop.tick(); // not due again yet (next run is 1h ahead)

      expect(dispatcher.calls).toHaveLength(1);
    });
  });

  describe("stale bindings", () => {
    it("disables a schedule whose locator is now bound to a different session", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const first = manager.createForChat(loc);
      const created = store.create({
        sessionId: first.id,
        locator: loc,
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      // Rebind the locator to a brand-new session (e.g. /new in a DM).
      manager.createForChat(loc);

      await makeLoop().tick();

      const after = store.getForSession(first.id, created.id);
      expect(after!.enabled).toBe(false);
      expect(after!.state).toBe("disabled");
      expect(after!.lastRun!.outcome).toBe("binding-mismatch");
      expect(dispatcher.calls).toHaveLength(0);
    });

    it("disables a schedule whose locator resolves to no session (mismatch)", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: { chatId: 999 }, // different, unbound locator captured
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });

      await makeLoop().tick();

      const after = store.getForSession(session.id, created.id);
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("binding-mismatch");
      expect(dispatcher.calls).toHaveLength(0);
    });
  });

  describe("archived session skip", () => {
    it("disables the schedule with outcome 'archived' and does not recreate the session", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: loc,
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      manager.archive(session.id);

      const sessionsBefore = manager.list().length;
      await makeLoop().tick();
      const sessionsAfter = manager.list().length;

      // SHALL NOT recreate or resume the archived session.
      expect(sessionsAfter).toBe(sessionsBefore);
      // The archived session is not in the live list.
      expect(manager.list().some((s) => s.id === session.id)).toBe(false);

      const after = store.getForSession(session.id, created.id);
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("archived");
      expect(dispatcher.calls).toHaveLength(0);
    });

    it("labels a deleted-but-not-archived session as binding-mismatch, not archived", async () => {
      // Pattern C precision: only sessions archived via archive() get the
      // "archived" outcome. A session whose dir was removed manually (or that
      // simply never existed for the captured locator) is a binding-mismatch.
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: loc,
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      // Simulate deletion without archive: clear the DM binding and remove the
      // dir directly, so peekBinding returns null and isArchived is false.
      const { rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      rmSync(join(tmpDir, "sessions", session.id), { recursive: true, force: true });
      // The DM binding in config.json still references the deleted session;
      // peekBinding reads binding + loadState, finds state missing → null.

      await makeLoop().tick();

      const after = store.getForSession(session.id, created.id);
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("binding-mismatch");
      expect(dispatcher.calls).toHaveLength(0);
    });
  });

  describe("tick errors", () => {
    it("logs a tick error and continues on the next tick", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      // Force a throw from the dispatcher on the first dispatch.
      const throwingDispatcher: SchedulerDispatcher = {
        enqueueScheduledTurn: () => {
          throw new Error("boom");
        },
      };
      const loop = new SchedulerLoop({ store, manager, dispatcher: throwingDispatcher, clock: clock.clock });

      // The tick must not reject even though dispatch threw.
      await expect(loop.tick()).resolves.toBeUndefined();

      // A subsequent tick with a healthy dispatcher still runs.
      const healthy = makeLoop();
      // The one-shot above was already claimed (completed) before dispatch
      // threw, so nothing is due now. Create a fresh due schedule to prove
      // ticks continue.
      store.create({
        sessionId: session.id,
        locator: loc,
        kind: "once",
        prompt: "y",
        nextRunAt: new Date(NOW_MS - 2000).toISOString(),
      });
      await healthy.tick();
      expect(dispatcher.calls).toHaveLength(1);
    });

    it("records an error lastRun when dispatch throws synchronously", async () => {
      // Pattern B: a synchronous throw from enqueueScheduledTurn must not
      // leave the claimed schedule with a stale/absent lastRun. The schedule
      // was already claimed (one-shot completed, recurring advanced) before
      // dispatch; the throw records outcome "error" so the record reflects
      // reality.
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      const created = store.create({
        sessionId: session.id,
        locator: loc,
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });

      const throwingDispatcher: SchedulerDispatcher = {
        enqueueScheduledTurn: () => {
          throw new Error("sync boom");
        },
      };
      const loop = new SchedulerLoop({ store, manager, dispatcher: throwingDispatcher, clock: clock.clock });

      await expect(loop.tick()).resolves.toBeUndefined();

      const after = store.getForSession(session.id, created.id);
      expect(after!.lastRun).toBeDefined();
      expect(after!.lastRun!.outcome).toBe("error");
      expect(after!.lastRun!.message).toContain("sync boom");
      // The recurring schedule was advanced before the throw (not re-due now).
      expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(NOW_MS);
    });
  });

  describe("heartbeat prompt content", () => {
    it("dispatches the heartbeat prompt for a due heartbeat schedule", async () => {
      const loc: ChatLocator = { chatId: 100 };
      const session = manager.createForChat(loc);
      store.setHeartbeat({
        sessionId: session.id,
        locator: loc,
        enabled: true,
        now: new Date(NOW_MS - 1800_000).toISOString(), // 30m ago → due now
      });

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe(HEARTBEAT_PROMPT);
      expect(dispatcher.calls[0]!.content.startsWith("[heartbeat]")).toBe(true);
    });
  });

  describe("stop behavior", () => {
    it("stop clears the timer and is idempotent", () => {
      let cleared = 0;
      let setCount = 0;
      const countingClock: SchedulerClock = {
        now: () => NOW_MS,
        setInterval: () => {
          setCount++;
          return { clear: () => { cleared++; } };
        },
      };
      const loop = new SchedulerLoop({
        store,
        manager,
        dispatcher,
        clock: countingClock,
        tickIntervalMs: 1000,
      });

      loop.start();
      expect(setCount).toBe(1);
      loop.stop();
      expect(cleared).toBe(1);
      // Idempotent: stopping again does nothing.
      loop.stop();
      expect(cleared).toBe(1);
    });

    it("start is idempotent (no second timer)", () => {
      let setCount = 0;
      const countingClock: SchedulerClock = {
        now: () => NOW_MS,
        setInterval: () => {
          setCount++;
          return { clear: () => {} };
        },
      };
      const loop = new SchedulerLoop({
        store,
        manager,
        dispatcher,
        clock: countingClock,
        tickIntervalMs: 1000,
      });

      loop.start();
      loop.start();
      expect(setCount).toBe(1);
      loop.stop();
    });

    it("stop before start is a no-op", () => {
      const loop = makeLoop();
      expect(() => loop.stop()).not.toThrow();
    });
  });
});
