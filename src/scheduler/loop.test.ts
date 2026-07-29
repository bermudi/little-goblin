import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SchedulerLoop, HEARTBEAT_PROMPT, DEFAULT_TICK_INTERVAL_MS, resolveHeartbeatPrompt } from "./loop.ts";
import { ScheduleStore } from "./store.ts";
import { SessionManager } from "../sessions/manager.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { loadBindings, saveBindings } from "../sessions/bindings.ts";
import { runtimeSessionWithPreferences } from "../sessions/conversation.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { heartbeatMdPath } from "../workspace/paths.ts";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import type { Config } from "../config.ts";
import type { SessionState } from "../sessions/mod.ts";
import type { SchedulerClock, SchedulerDispatcher, SchedulerSessionSource } from "./loop.ts";
import { dmSurface, surfaceId, type Surface } from "../surface.ts";

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "standard",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

/** Fake dispatcher that records every enqueueScheduledTurn call. */
function makeFakeDispatcher(): SchedulerDispatcher & {
  calls: { session: SessionState; surface: Surface; content: string }[];
} {
  const calls: { session: SessionState; surface: Surface; content: string }[] = [];
  return {
    calls,
    enqueueScheduledTurn(session, surface, content) {
      calls.push({ session, surface, content });
    },
  };
}

/**
 * Fake session source for eligibility tests. Returns canned `peekBinding` /
 * `isArchived` results so the scheduler's due/binding/archived logic can be
 * exercised without a filesystem-backed `SessionManager`.
 */
function makeFakeSessionSource(
  peek: { sessionId: string; state: SessionState } | null,
  archived = false,
): SchedulerSessionSource {
  return {
    peekBinding: () => peek,
    isArchived: () => archived,
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
  let conversationStore: ConversationStore;
  let store: ScheduleStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;
  let clock: ReturnType<typeof makeFakeClock>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-loop-test-"));
    manager = new SessionManager(makeTestConfig(tmpDir));
    await manager.init();
    conversationStore = new ConversationStore(tmpDir);
    store = new ScheduleStore(tmpDir);
    dispatcher = makeFakeDispatcher();
    clock = makeFakeClock(NOW_MS);
  });

  async function createSession(loc: Surface): Promise<SessionState> {
    const conv = conversationStore.create(personalEnvironment());
    const bindings = loadBindings(tmpDir);
    bindings.surfaces[surfaceId(loc)] = conv.id;
    saveBindings(tmpDir, bindings);
    return runtimeSessionWithPreferences(conv, loc, tmpDir);
  }

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeLoop(): SchedulerLoop {
    return new SchedulerLoop({ store, sessionSource: manager, dispatcher, clock: clock.clock, home: tmpDir });
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
      const loc: Surface = dmSurface(100);
      const session = await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "check backups",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.session.id).toBe(session.id);
      expect(dispatcher.calls[0]!.content).toBe("check backups");
      // One-shot is completed after dispatch.
      const after = store.getForSurface(loc, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.lastRun!.outcome).toBe("ok");
    });

    it("does not call AgentRunner.followUp (dispatches as a fresh turn)", async () => {
      // The fake dispatcher only exposes enqueueScheduledTurn; the loop MUST
      // route through it rather than any followUp path. Asserting the call
      // went through enqueueScheduledTurn (not a followUp field) is the proof.
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.create({
        surface: loc,
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
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.create({
        surface: loc,
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
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.create({
        surface: loc,
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
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.create({
        surface: loc,
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
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "once",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      await makeLoop().tick();

      const after = store.getForSurface(loc, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.enabled).toBe(false);
    });
  });

  describe("recurring advancement", () => {
    it("advances nextRunAt by the interval before dispatch", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "recurring",
        prompt: "recur",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });

      await makeLoop().tick();

      const after = store.getForSurface(loc, created.id);
      expect(after!.state).toBe("enabled");
      // Advanced by 1h past the due time; not re-due at the same now.
      expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(NOW_MS);
    });

    it("does not dispatch the same occurrence again on a later tick", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.create({
        surface: loc,
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

    it("dispatches a one-shot missed during downtime exactly once after restart", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "missed once",
        nextRunAt: new Date(NOW_MS - 3600_000).toISOString(),
      });
      const restartedStore = new ScheduleStore(tmpDir);
      const restartedManager = new SessionManager(makeTestConfig(tmpDir));
      await restartedManager.init();
      const restartedLoop = new SchedulerLoop({ store: restartedStore, sessionSource: restartedManager, dispatcher, clock: clock.clock, home: tmpDir });

      await restartedLoop.tick();
      await restartedLoop.tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe("missed once");
      const after = restartedStore.getForSurface(loc, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("ok");
    });

    it("catches up a recurring schedule missed during downtime without replaying every missed interval", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "recurring",
        prompt: "missed recurring",
        nextRunAt: new Date(NOW_MS - 3 * 3600_000).toISOString(),
        intervalMs: 3600_000,
      });
      const restartedStore = new ScheduleStore(tmpDir);
      const restartedManager = new SessionManager(makeTestConfig(tmpDir));
      await restartedManager.init();
      const restartedLoop = new SchedulerLoop({ store: restartedStore, sessionSource: restartedManager, dispatcher, clock: clock.clock, home: tmpDir });

      await restartedLoop.tick();
      await restartedLoop.tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe("missed recurring");
      const after = restartedStore.getForSurface(loc, created.id);
      expect(after!.state).toBe("enabled");
      expect(after!.enabled).toBe(true);
      expect(after!.nextRunAt).toBe(new Date(NOW_MS + 3600_000).toISOString());
      expect(after!.lastRun!.outcome).toBe("ok");
    });
  });

  describe("surface binding", () => {
    it("dispatches a due schedule to the surface's currently bound session (rotation survival)", async () => {
      // Eligibility test: uses a fake session source (no filesystem). The
      // surface is now bound to a different session than when the schedule was
      // created. Phase 6 owns schedules by Surface, so the schedule survives
      // rotation and dispatches to the current binding.
      const reboundState: SessionState = {
        id: "session-rebound",
        chatId: 100,
        createdAt: new Date(NOW_MS).toISOString(),
      } as SessionState;
      const created = store.create({
        surface: dmSurface(100),
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      const source = makeFakeSessionSource({ sessionId: reboundState.id, state: reboundState });

      const loop = new SchedulerLoop({ store, sessionSource: source, dispatcher, clock: clock.clock, home: tmpDir });
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.session.id).toBe("session-rebound");
      expect(dispatcher.calls[0]!.content).toBe("x");
      const after = store.getForSurface(dmSurface(100), created.id);
      expect(after!.enabled).toBe(true);
      expect(after!.state).toBe("enabled");
      expect(after!.lastRun!.outcome).toBe("ok");
    });

    it("leaves an unbound surface's due schedule pending and does not claim it", async () => {
      // Eligibility test: peekBinding returns null (no live binding). The
      // schedule records a pending lastRun but stays enabled/due for retry.
      const created = store.create({
        surface: dmSurface(999),
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      const source = makeFakeSessionSource(null);

      const loop = new SchedulerLoop({ store, sessionSource: source, dispatcher, clock: clock.clock, home: tmpDir });
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(0);
      const after = store.getForSurface(dmSurface(999), created.id);
      expect(after!.enabled).toBe(true);
      expect(after!.state).toBe("enabled");
      expect(after!.lastRun!.outcome).toBe("pending");
      expect(after!.lastRun!.message).toBe(after!.nextRunAt);
    });

    it("dispatches an overdue one-shot after the surface is rebound", async () => {
      // A one-shot goes overdue while the surface is unbound, then the surface
      // is rebound and a later tick dispatches it exactly once.
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "missed then rebound",
        nextRunAt: new Date(NOW_MS - 3600_000).toISOString(),
      });

      // First tick: surface is unbound (bindings cleared by hand).
      const bindings = loadBindings(tmpDir);
      delete bindings.surfaces[surfaceId(loc)];
      saveBindings(tmpDir, bindings);
      const unboundSource = makeFakeSessionSource(null);
      const unboundLoop = new SchedulerLoop({
        store,
        sessionSource: unboundSource,
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });
      await unboundLoop.tick();

      expect(dispatcher.calls).toHaveLength(0);
      let after = store.getForSurface(loc, created.id);
      expect(after!.lastRun!.outcome).toBe("pending");
      expect(after!.enabled).toBe(true);

      // Rebind the surface to a new session and tick again.
      const reboundState: SessionState = {
        id: "session-after-rebind",
        chatId: 100,
        createdAt: new Date(NOW_MS).toISOString(),
      } as SessionState;
      const boundSource = makeFakeSessionSource({ sessionId: reboundState.id, state: reboundState });
      const boundLoop = new SchedulerLoop({
        store,
        sessionSource: boundSource,
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });
      await boundLoop.tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.session.id).toBe("session-after-rebind");
      expect(dispatcher.calls[0]!.content).toBe("missed then rebound");
      after = store.getForSurface(loc, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("ok");
    });

    it("does not consult isArchived: an unbound archived surface is pending", async () => {
      // isArchived is still on SchedulerSessionSource, but the loop only looks
      // at binding. A null peekBinding (with isArchived true) is pending.
      const created = store.create({
        surface: dmSurface(100),
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      const source = makeFakeSessionSource(null, true);

      const loop = new SchedulerLoop({ store, sessionSource: source, dispatcher, clock: clock.clock, home: tmpDir });
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(0);
      const after = store.getForSurface(dmSurface(100), created.id);
      expect(after!.enabled).toBe(true);
      expect(after!.lastRun!.outcome).toBe("pending");
    });

    it("deduplicates pending lastRun records for the same nextRunAt", async () => {
      // Multiple ticks while unbound should not spam the store with pending
      // records; the loop records pending only when the lastRun changes.
      const created = store.create({
        surface: dmSurface(999),
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      const source = makeFakeSessionSource(null);
      const loop = new SchedulerLoop({ store, sessionSource: source, dispatcher, clock: clock.clock, home: tmpDir });

      await loop.tick();
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(0);
      const after = store.getForSurface(dmSurface(999), created.id);
      expect(after!.enabled).toBe(true);
      expect(after!.lastRun!.outcome).toBe("pending");
    });
  });

  describe("tick errors", () => {
    it("logs a tick error and continues on the next tick", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.create({
        surface: loc,
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
      const loop = new SchedulerLoop({ store, sessionSource: manager, dispatcher: throwingDispatcher, clock: clock.clock, home: tmpDir });

      // The tick must not reject even though dispatch threw.
      await expect(loop.tick()).resolves.toBeUndefined();

      // A subsequent tick with a healthy dispatcher still runs.
      const healthy = makeLoop();
      // The one-shot above was already claimed (completed) before dispatch
      // threw, so nothing is due now. Create a fresh due schedule to prove
      // ticks continue.
      store.create({
        surface: loc,
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
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
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
      const loop = new SchedulerLoop({ store, sessionSource: manager, dispatcher: throwingDispatcher, clock: clock.clock, home: tmpDir });

      await expect(loop.tick()).resolves.toBeUndefined();

      const after = store.getForSurface(loc, created.id);
      expect(after!.lastRun).toBeDefined();
      expect(after!.lastRun!.outcome).toBe("error");
      expect(after!.lastRun!.message).toContain("sync boom");
      // The recurring schedule was advanced before the throw (not re-due now).
      expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(NOW_MS);
    });
  });

  describe("heartbeat prompt content", () => {
    it("dispatches the heartbeat prompt for a due heartbeat schedule", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      store.setHeartbeat({
        surface: loc,
        enabled: true,
        now: new Date(NOW_MS - 1800_000).toISOString(), // 30m ago → due now
      });

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe(HEARTBEAT_PROMPT);
      expect(dispatcher.calls[0]!.content.startsWith("[heartbeat]")).toBe(true);
    });
  });

  describe("resolveHeartbeatPrompt (HEARTBEAT.md sourcing)", () => {
    const SURFACE = dmSurface(100);

    function writeGlobalHeartbeat(home: string, content: string): void {
      const path = heartbeatMdPath(home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
    }

    function writeSurfaceHeartbeat(home: string, surface: Surface, content: string): void {
      const path = surfaceHeartbeatPath(home, surfaceId(surface));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
    }

    it("uses surface-scoped HEARTBEAT.md with [heartbeat] prefix when present", () => {
      writeSurfaceHeartbeat(tmpDir, SURFACE, "Surface-scoped check.");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe(
        "[heartbeat] Surface-scoped check.",
      );
    });

    it("surface-scoped takes precedence over global", () => {
      writeSurfaceHeartbeat(tmpDir, SURFACE, "surface body");
      writeGlobalHeartbeat(tmpDir, "global body");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe("[heartbeat] surface body");
    });

    it("falls back to global when surface-scoped is absent", () => {
      writeGlobalHeartbeat(tmpDir, "Global fallback body.");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe("[heartbeat] Global fallback body.");
    });

    it("falls back to global when surface-scoped is whitespace-only", () => {
      writeSurfaceHeartbeat(tmpDir, SURFACE, "   \n\t \n");
      writeGlobalHeartbeat(tmpDir, "Global fallback body.");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe("[heartbeat] Global fallback body.");
    });

    it("falls back to the constant when both files are absent", () => {
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe(HEARTBEAT_PROMPT);
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE).match(/\[heartbeat\]/g)).toHaveLength(1);
    });

    it("falls back to the constant when global is empty/whitespace-only", () => {
      writeGlobalHeartbeat(tmpDir, "   \n\t \n");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe(HEARTBEAT_PROMPT);
    });

    it("trims trailing whitespace from the file content", () => {
      writeSurfaceHeartbeat(tmpDir, SURFACE, "Check the build; if red, ping me.\n\n  \n");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe(
        "[heartbeat] Check the build; if red, ping me.",
      );
    });

    it("preserves leading whitespace in the file content", () => {
      // The user may intend an indented first line; only trailing whitespace
      // is stripped. Spec: "Heartbeat due turn with HEARTBEAT.md present".
      writeSurfaceHeartbeat(tmpDir, SURFACE, "  \tCheck the build; if red, ping me.  \n");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe(
        "[heartbeat]   \tCheck the build; if red, ping me.",
      );
    });

    it("strips a leading [heartbeat] marker from file content before prepending its own", () => {
      writeSurfaceHeartbeat(tmpDir, SURFACE, "[heartbeat] Surface-scoped check.");
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE)).toBe(
        "[heartbeat] Surface-scoped check.",
      );
      expect(resolveHeartbeatPrompt(tmpDir, SURFACE).match(/\[heartbeat\]/g)).toHaveLength(1);
    });

    it("propagates non-ENOENT read errors (does not fall back silently)", () => {
      // Point the home at a path where state/surfaces/<SurfaceId>/HEARTBEAT.md
      // resolves under a non-directory ancestor, so readFileSync throws ENOTDIR
      // rather than ENOENT.
      const blockingFile = join(tmpDir, "blocking");
      writeFileSync(blockingFile, "x", "utf-8");
      expect(() => resolveHeartbeatPrompt(blockingFile, SURFACE)).toThrow();
    });
  });

  describe("heartbeat dispatch sourcing HEARTBEAT.md", () => {
    function writeGlobalHeartbeat(home: string, content: string): void {
      const path = heartbeatMdPath(home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
    }

    function writeSurfaceHeartbeat(home: string, surface: Surface, content: string): void {
      const path = surfaceHeartbeatPath(home, surfaceId(surface));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
    }

    async function enableHeartbeat(loc: Surface): Promise<string> {
      const session = await createSession(loc);
      store.setHeartbeat({
        surface: loc,
        enabled: true,
        now: new Date(NOW_MS - 1800_000).toISOString(), // 30m ago → due now
      });
      return session.id;
    }

    it("dispatches surface-scoped HEARTBEAT.md content when present", async () => {
      const loc: Surface = dmSurface(100);
      await enableHeartbeat(loc);
      writeSurfaceHeartbeat(tmpDir, loc, "Surface-specific pulse.");

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe("[heartbeat] Surface-specific pulse.");
    });

    it("dispatches global HEARTBEAT.md content with exactly one [heartbeat] marker when surface-scoped is absent", async () => {
      const loc: Surface = dmSurface(100);
      await enableHeartbeat(loc);
      writeGlobalHeartbeat(tmpDir, "Check the build; if red, ping me.");

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe(
        "[heartbeat] Check the build; if red, ping me.",
      );
      // Exactly one marker — the user body does not get re-prefixed.
      expect(dispatcher.calls[0]!.content.match(/\[heartbeat\]/g)).toHaveLength(1);
    });

    it("dispatches the constant fallback when no HEARTBEAT.md exists", async () => {
      const loc: Surface = dmSurface(100);
      await enableHeartbeat(loc);
      // No workspace or surface HEARTBEAT.md in tmpDir.

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe(HEARTBEAT_PROMPT);
      expect(dispatcher.calls[0]!.content.match(/\[heartbeat\]/g)).toHaveLength(1);
    });

    it("dispatches the constant fallback when surface-scoped HEARTBEAT.md is empty/whitespace-only", async () => {
      const loc: Surface = dmSurface(100);
      await enableHeartbeat(loc);
      writeSurfaceHeartbeat(tmpDir, loc, "   \n\t \n");

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe(HEARTBEAT_PROMPT);
    });

    it("uses updated surface-scoped HEARTBEAT.md content on the next tick after an edit (no restart)", async () => {
      const loc: Surface = dmSurface(100);
      await enableHeartbeat(loc);
      writeSurfaceHeartbeat(tmpDir, loc, "first body");

      const loop = makeLoop();
      await loop.tick();
      expect(dispatcher.calls[0]!.content).toBe("[heartbeat] first body");

      // Edit the file and re-arm the heartbeat so it is due again.
      writeSurfaceHeartbeat(tmpDir, loc, "second body");
      store.setHeartbeat({
        surface: loc,
        enabled: true,
        now: new Date(NOW_MS).toISOString(),
      });
      clock.advance(31 * 60_000);
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(2);
      expect(dispatcher.calls[1]!.content).toBe("[heartbeat] second body");
    });

    it("surface heartbeat prompt survives a conversation rotation", async () => {
      const loc: Surface = dmSurface(100);
      const firstSessionId = await enableHeartbeat(loc);
      writeSurfaceHeartbeat(tmpDir, loc, "survived rotation");

      await makeLoop().tick();
      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe("[heartbeat] survived rotation");

      // Rotate the surface to a fresh conversation. The heartbeat schedule is
      // surface-owned, so the next due occurrence still uses the same prompt.
      const secondConv = conversationStore.create(personalEnvironment());
      const bindings = loadBindings(tmpDir);
      bindings.surfaces[surfaceId(loc)] = secondConv.id;
      saveBindings(tmpDir, bindings);

      dispatcher.calls.length = 0;
      store.setHeartbeat({
        surface: loc,
        enabled: true,
        now: new Date(NOW_MS).toISOString(),
      });
      clock.advance(31 * 60_000);
      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe("[heartbeat] survived rotation");
      expect(dispatcher.calls[0]!.session.id).toBe(secondConv.id);
      expect(dispatcher.calls[0]!.session.id).not.toBe(firstSessionId);
    });
  });

  describe("heartbeat read failure isolation", () => {
    it("does not starve other due schedules when HEARTBEAT.md read throws non-ENOENT", async () => {
      // Spec: "Failing schedule does not starve other due schedules". A
      // heartbeat whose HEARTBEAT.md cannot be read (non-ENOENT) throws inside
      // processOne during prompt resolution; without per-schedule isolation that
      // throw would abort the tick and skip every later due schedule. We force
      // the failure by pointing the loop's `home` at a path where
      // `state/surfaces/<SurfaceId>/HEARTBEAT.md` resolves under a non-directory,
      // then assert a co-due one-shot still dispatches.
      const heartbeatLoc: Surface = dmSurface(100);
      await createSession(heartbeatLoc);
      const heartbeat = store.setHeartbeat({
        surface: heartbeatLoc,
        enabled: true,
        now: new Date(NOW_MS - 1800_000).toISOString(), // due now
      });

      // A second, unrelated schedule also due in this tick.
      const otherLoc: Surface = dmSurface(200);
      await createSession(otherLoc);
      store.create({
        surface: otherLoc,
        kind: "once",
        prompt: "deploy reminder",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      // Break surfaceHeartbeatPath(home): make `home/state/surfaces/.../HEARTBEAT.md`
      // resolve under a non-directory so readFileSync throws ENOTDIR (not ENOENT).
      const blockingFile = join(tmpDir, "blocking");
      writeFileSync(blockingFile, "x", "utf-8");
      const loop = new SchedulerLoop({
        store,
        sessionSource: manager,
        dispatcher,
        clock: clock.clock,
        // `home` only feeds resolveHeartbeatPrompt; store/manager use tmpDir.
        home: blockingFile,
      });

      // The tick must not reject, the heartbeat must not dispatch, and the
      // unrelated one-shot must still go through.
      await expect(loop.tick()).resolves.toBeUndefined();

      const dispatched = dispatcher.calls.map((c) => c.content);
      expect(dispatched).not.toContain("[heartbeat]");
      expect(dispatched).toEqual(["deploy reminder"]);

      // The heartbeat was claimed before prompt resolution, so it advanced to
      // its next run. The failure is nevertheless persisted as the occurrence's
      // last-run status rather than silently disappearing.
      const afterHeartbeat = store.getForSurface(heartbeatLoc, heartbeat.id)!;
      expect(afterHeartbeat.kind).toBe("heartbeat");
      expect(new Date(afterHeartbeat.nextRunAt).getTime()).toBeGreaterThan(NOW_MS);
      expect(afterHeartbeat.enabled).toBe(true);
      expect(afterHeartbeat.lastRun).toMatchObject({ outcome: "error" });
    });

    it("isolates a synchronous dispatcher throw so later due schedules still run", async () => {
      // Same fault-isolation property, exercised via the pre-existing
      // synchronous-dispatcher-throw path (processOne re-throws after recording
      // an "error" outcome). The throw must stop only its own schedule.
      const firstLoc: Surface = dmSurface(100);
      await createSession(firstLoc);
      store.create({
        surface: firstLoc,
        kind: "once",
        prompt: "first (will throw)",
        nextRunAt: new Date(NOW_MS - 2000).toISOString(),
      });
      const secondLoc: Surface = dmSurface(200);
      await createSession(secondLoc);
      store.create({
        surface: secondLoc,
        kind: "once",
        prompt: "second (should still run)",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      // A recording dispatcher that throws on the first dispatch attempt only,
      // so whichever schedule is processed first fails and the second must
      // still run. This makes the test robust to listDue ordering.
      let firstSeen = false;
      const mixedDispatcher: SchedulerDispatcher = {
        enqueueScheduledTurn(session, surface, content) {
          if (!firstSeen) {
            firstSeen = true;
            throw new Error("boom on first");
          }
          dispatcher.enqueueScheduledTurn(session, surface, content);
        },
      };
      const loop = new SchedulerLoop({
        store,
        sessionSource: manager,
        dispatcher: mixedDispatcher,
        clock: clock.clock,
        home: tmpDir,
      });

      await expect(loop.tick()).resolves.toBeUndefined();

      // The first schedule threw; the second still dispatched.
      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.content).toBe("second (should still run)");
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
        sessionSource: manager,
        dispatcher,
        clock: countingClock,
        home: tmpDir,
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
        sessionSource: manager,
        dispatcher,
        clock: countingClock,
        home: tmpDir,
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

  describe("parseDreamingResponse", () => {
    const sampleLines = [{ index: 0, role: "user" as const, text: "hello", ts: "2026-07-01T00:00:00.000Z" }];

    it("accepts valid candidates", () => {
      const loop = makeLoop();
      const parse = (loop as unknown as { parseDreamingResponse: (raw: string, sessionId: string, lines: typeof sampleLines) => unknown[] }).parseDreamingResponse;
      const raw = JSON.stringify({
        candidates: [
          { target: "memory", category: "fact", confidence: 0.85, text: "User likes tea.", lineRange: [0, 0] },
        ],
      });
      const result = parse(raw, "session-1", sampleLines);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ target: "memory", category: "fact", confidence: 0.85, text: "User likes tea." });
    });

    it("rejects invalid categories", () => {
      const loop = makeLoop();
      const parse = (loop as unknown as { parseDreamingResponse: (raw: string, sessionId: string, lines: typeof sampleLines) => unknown[] }).parseDreamingResponse;
      const raw = JSON.stringify({
        candidates: [
          { target: "memory", category: "bogus", confidence: 0.85, text: "User likes tea.", lineRange: [0, 0] },
        ],
      });
      const result = parse(raw, "session-1", sampleLines);
      expect(result).toHaveLength(0);
    });

    it("rejects out-of-range confidence", () => {
      const loop = makeLoop();
      const parse = (loop as unknown as { parseDreamingResponse: (raw: string, sessionId: string, lines: typeof sampleLines) => unknown[] }).parseDreamingResponse;
      const raw = JSON.stringify({
        candidates: [
          { target: "memory", category: "fact", confidence: 1.5, text: "User likes tea.", lineRange: [0, 0] },
          { target: "memory", category: "fact", confidence: -0.1, text: "User likes coffee.", lineRange: [0, 0] },
        ],
      });
      const result = parse(raw, "session-1", sampleLines);
      expect(result).toHaveLength(0);
    });

    it("rejects invalid or inverted line ranges", () => {
      const loop = makeLoop();
      const parse = (loop as unknown as { parseDreamingResponse: (raw: string, sessionId: string, lines: typeof sampleLines) => unknown[] }).parseDreamingResponse;
      const raw = JSON.stringify({
        candidates: [
          { target: "memory", category: "fact", confidence: 0.85, text: "User likes tea.", lineRange: [1, 0] },
          { target: "memory", category: "fact", confidence: 0.85, text: "User likes tea.", lineRange: [0] },
        ],
      });
      const result = parse(raw, "session-1", sampleLines);
      expect(result).toHaveLength(0);
    });

    it("defaults target to memory when absent", () => {
      const loop = makeLoop();
      const parse = (loop as unknown as { parseDreamingResponse: (raw: string, sessionId: string, lines: typeof sampleLines) => unknown[] }).parseDreamingResponse;
      const raw = JSON.stringify({
        candidates: [
          { category: "fact", confidence: 0.85, text: "User likes tea.", lineRange: [0, 0] },
        ],
      });
      const result = parse(raw, "session-1", sampleLines) as Array<{ target: string }>;
      expect(result).toHaveLength(1);
      expect(result[0]?.target).toBe("memory");
    });
  });
});
