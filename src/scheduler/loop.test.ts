import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SchedulerLoop, HEARTBEAT_PROMPT, DEFAULT_TICK_INTERVAL_MS, resolveHeartbeatPrompt } from "./loop.ts";
import { ScheduleStore } from "./store.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { InternalSessionStore } from "../sessions/internal-session-store.ts";
import {
  createConversationLifecycle,
  reconcileProjectAssignmentAtColdStart,
  type ConversationLifecycle,
} from "../orchestration/conversation-lifecycle.ts";
import type { MemoryEngine } from "../memory/engine.ts";
import { loadBindings, saveBindings } from "../sessions/bindings.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { heartbeatMdPath } from "../workspace/paths.ts";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import type { ConversationState } from "../sessions/mod.ts";
import type { SchedulerClock, SchedulerConversationLifecycle, SchedulerDispatcher } from "./loop.ts";
import { dmSurface, surfaceId, type Surface } from "../surface.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Fake dispatcher that records every enqueueScheduledTurn call. */
function makeFakeDispatcher(admission: { open: boolean } = { open: true }): SchedulerDispatcher & {
  calls: { conversation: ConversationState; surface: Surface; content: string }[];
  setAdmissionOpen(open: boolean): void;
} {
  const calls: { conversation: ConversationState; surface: Surface; content: string }[] = [];
  return {
    calls,
    runtimeAdmissionOpen: () => admission.open,
    setAdmissionOpen: (open) => { admission.open = open; },
    enqueueScheduledTurn(conversation, surface, content) {
      calls.push({ conversation, surface, content });
      return true;
    },
  };
}

/** Fake lifecycle resolver for binding eligibility tests. */
function makeFakeLifecycle(
  conversation: ConversationState | null,
): SchedulerConversationLifecycle {
  return {
    resolveCurrent: async () => conversation,
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
  let lifecycle: ConversationLifecycle;
  let conversationStore: ConversationStore;
  let internalSessionStore: InternalSessionStore;
  let store: ScheduleStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;
  let clock: ReturnType<typeof makeFakeClock>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-loop-test-"));
    lifecycle = createConversationLifecycle(tmpDir, {
      hasRuntime: () => false,
      disposeRuntime: async () => {},
    });
    conversationStore = new ConversationStore(tmpDir);
    internalSessionStore = new InternalSessionStore(tmpDir);
    store = new ScheduleStore(tmpDir);
    dispatcher = makeFakeDispatcher();
    clock = makeFakeClock(NOW_MS);
  });

  async function createSession(loc: Surface): Promise<ConversationState> {
    const conv = conversationStore.create(personalEnvironment());
    const bindings = loadBindings(tmpDir);
    bindings.surfaces[surfaceId(loc)] = conv.id;
    saveBindings(tmpDir, bindings);
    return conv;
  }

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function schedulerDependencies(
    selectedLifecycle: SchedulerConversationLifecycle = lifecycle,
  ): {
    lifecycle: SchedulerConversationLifecycle;
    conversationCatalog: ConversationStore;
    internalSessionStore: InternalSessionStore;
  } {
    return {
      lifecycle: selectedLifecycle,
      conversationCatalog: conversationStore,
      internalSessionStore,
    };
  }

  function makeLoop(): SchedulerLoop {
    return new SchedulerLoop({
      store,
      ...schedulerDependencies(),
      dispatcher,
      clock: clock.clock,
      home: tmpDir,
    });
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
    it("dispatches a due schedule whose Conversation is still bound", async () => {
      const loc: Surface = dmSurface(100);
      const conversation = await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "check backups",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      await makeLoop().tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.conversation.id).toBe(conversation.id);
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

  describe("busy-Conversation queueing", () => {
    it("dispatches via the shared dispatcher even when the prompt is synthetic", async () => {
      // The dispatcher (real TurnDispatcher) serializes through the
      // per-Conversation queue; here we assert the loop hands the work to the
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
    it("does not claim a one-shot when shutdown closes runtime admission during an in-flight tick", async () => {
      const loc: Surface = dmSurface(100);
      const conversation = await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "must survive shutdown",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });

      let releaseResolution!: (conversation: ConversationState | null) => void;
      const resolution = new Promise<ConversationState | null>((resolve) => {
        releaseResolution = resolve;
      });
      const inFlightLifecycle: SchedulerConversationLifecycle = {
        resolveCurrent: () => resolution,
      };
      const loop = new SchedulerLoop({
        store,
        ...schedulerDependencies(inFlightLifecycle),
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });

      loop.start();
      const tick = loop.tick();
      loop.stop();
      // Runtime admission is deliberately still open: SchedulerLoop.stop()
      // itself must fence a tick that was already resolving the binding.
      expect(dispatcher.runtimeAdmissionOpen()).toBe(true);
      releaseResolution(conversation);
      await tick;

      expect(dispatcher.calls).toHaveLength(0);
      const after = store.getForSurface(loc, created.id);
      expect(after!.enabled).toBe(true);
      expect(after!.state).toBe("enabled");
      expect(after!.nextRunAt).toBe(created.nextRunAt);
      expect(after!.lastRun).toBeUndefined();
    });

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

    it("waits for and restores an occurrence whose queued turn is fenced", async () => {
      await createSession(dmSurface(100));
      const schedule = store.create({
        surface: dmSurface(100),
        kind: "once",
        prompt: "restore me",
        nextRunAt: new Date(NOW_MS - 1_000).toISOString(),
      });
      const started = deferred<boolean>();
      dispatcher = {
        ...dispatcher,
        enqueueScheduledTurn: () => ({ accepted: true, started: started.promise }),
      };
      const loop = makeLoop();

      await loop.tick();
      expect(store.getForSurface(dmSurface(100), schedule.id)!.state).toBe("completed");

      const drain = loop.stopAndDrain();
      started.resolve(false);
      await drain;

      const restored = store.getForSurface(dmSurface(100), schedule.id)!;
      expect(restored.state).toBe("enabled");
      expect(restored.enabled).toBe(true);
      expect(restored.nextRunAt).toBe(schedule.nextRunAt);
    });

    it("restores a claim when the runtime queue rejects the occurrence", async () => {
      const surface = dmSurface(100);
      await createSession(surface);
      const once = store.create({
        surface,
        kind: "once",
        prompt: "do not consume me",
        nextRunAt: new Date(NOW_MS - 1_000).toISOString(),
      });
      const recurring = store.create({
        surface,
        kind: "recurring",
        prompt: "do not advance me",
        nextRunAt: new Date(NOW_MS - 1_000).toISOString(),
        intervalMs: 3_600_000,
      });
      dispatcher = {
        ...dispatcher,
        enqueueScheduledTurn: () => false,
      };

      await makeLoop().tick();

      const restoredOnce = store.getForSurface(surface, once.id)!;
      expect(restoredOnce.state).toBe("enabled");
      expect(restoredOnce.enabled).toBe(true);
      expect(restoredOnce.nextRunAt).toBe(once.nextRunAt);
      const restoredRecurring = store.getForSurface(surface, recurring.id)!;
      expect(restoredRecurring.state).toBe("enabled");
      expect(restoredRecurring.enabled).toBe(true);
      expect(restoredRecurring.nextRunAt).toBe(recurring.nextRunAt);
    });

    it("restores a claim when admission closes between the pre-check and enqueue", async () => {
      // The pre-check passes (runtimeAdmissionOpen() is true), but the
      // dispatcher's enqueue observes a closed admission and rejects. The
      // claim must be restored so the occurrence stays due — the manual
      // restore is the single structural path that covers this race.
      const surface = dmSurface(100);
      await createSession(surface);
      const once = store.create({
        surface,
        kind: "once",
        prompt: "survive admission race",
        nextRunAt: new Date(NOW_MS - 1_000).toISOString(),
      });
      const recurring = store.create({
        surface,
        kind: "recurring",
        prompt: "survive admission race",
        nextRunAt: new Date(NOW_MS - 1_000).toISOString(),
        intervalMs: 3_600_000,
      });

      let preCheckObservedOpen = false;
      const racingDispatcher: SchedulerDispatcher = {
        runtimeAdmissionOpen: () => {
          preCheckObservedOpen = true;
          return true;
        },
        enqueueScheduledTurn: () => {
          // Simulate admission closing at the enqueue boundary — after the
          // pre-check returned true but before the queue accepts the turn.
          return false;
        },
      };
      dispatcher = racingDispatcher as unknown as typeof dispatcher;

      await makeLoop().tick();

      expect(preCheckObservedOpen).toBe(true);

      const restoredOnce = store.getForSurface(surface, once.id)!;
      expect(restoredOnce.state).toBe("enabled");
      expect(restoredOnce.enabled).toBe(true);
      expect(restoredOnce.nextRunAt).toBe(once.nextRunAt);
      expect(restoredOnce.lastRun).toBeUndefined();

      const restoredRecurring = store.getForSurface(surface, recurring.id)!;
      expect(restoredRecurring.state).toBe("enabled");
      expect(restoredRecurring.enabled).toBe(true);
      expect(restoredRecurring.nextRunAt).toBe(recurring.nextRunAt);
    });

    it("reports a failed occurrence restoration through scheduler drain", async () => {
      await createSession(dmSurface(100));
      const schedule = store.create({
        surface: dmSurface(100),
        kind: "once",
        prompt: "fail restore",
        nextRunAt: new Date(NOW_MS - 1_000).toISOString(),
      });
      const started = deferred<boolean>();
      dispatcher = {
        ...dispatcher,
        enqueueScheduledTurn: () => ({ accepted: true, started: started.promise }),
      };
      store.restoreClaim = () => {
        throw new Error("restore failed");
      };
      const loop = makeLoop();

      await loop.tick();
      const drain = loop.stopAndDrain();
      started.resolve(false);
      await expect(drain).rejects.toThrow("restore failed");
      expect(store.getForSurface(dmSurface(100), schedule.id)!.state).toBe("completed");
    });
  });

  describe("one-shot completion", () => {
    it("does not record ok until an admitted turn actually starts", async () => {
      const loc: Surface = dmSurface(100);
      await createSession(loc);
      const created = store.create({
        surface: loc,
        kind: "once",
        prompt: "wait to start",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
      });
      const started = deferred<boolean>();
      dispatcher = {
        ...dispatcher,
        enqueueScheduledTurn: () => ({ accepted: true, started: started.promise }),
      };
      const loop = makeLoop();

      await loop.tick();
      expect(store.getForSurface(loc, created.id)!.lastRun).toBeUndefined();

      const drain = loop.stopAndDrain();
      started.resolve(true);
      await drain;

      expect(store.getForSurface(loc, created.id)!.lastRun!.outcome).toBe("ok");
    });

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
      reconcileProjectAssignmentAtColdStart(tmpDir);
      const restartedLifecycle = createConversationLifecycle(tmpDir, {
        hasRuntime: () => false,
        disposeRuntime: async () => {},
      });
      const restartedLoop = new SchedulerLoop({
        store: restartedStore,
        ...schedulerDependencies(restartedLifecycle),
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });

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
      reconcileProjectAssignmentAtColdStart(tmpDir);
      const restartedLifecycle = createConversationLifecycle(tmpDir, {
        hasRuntime: () => false,
        disposeRuntime: async () => {},
      });
      const restartedLoop = new SchedulerLoop({
        store: restartedStore,
        ...schedulerDependencies(restartedLifecycle),
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });

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
    it("dispatches a due schedule to the Surface's currently bound Conversation (rotation survival)", async () => {
      // Eligibility test: uses a fake lifecycle resolver (no filesystem). The
      // Surface is now bound to a different Conversation than when the schedule was
      // created. Phase 6 owns schedules by Surface, so the schedule survives
      // rotation and dispatches to the current binding.
      const reboundState: ConversationState = {
        id: "session-rebound",
        createdAt: new Date(NOW_MS).toISOString(),
        executionEnvironment: personalEnvironment(),
      };
      const created = store.create({
        surface: dmSurface(100),
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      const source = makeFakeLifecycle(reboundState);

      const loop = new SchedulerLoop({ store, ...schedulerDependencies(source), dispatcher, clock: clock.clock, home: tmpDir });
      await loop.tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.conversation.id).toBe("session-rebound");
      expect(dispatcher.calls[0]!.content).toBe("x");
      const after = store.getForSurface(dmSurface(100), created.id);
      expect(after!.enabled).toBe(true);
      expect(after!.state).toBe("enabled");
      expect(after!.lastRun!.outcome).toBe("ok");
    });

    it("leaves an unbound Surface's due schedule pending and does not claim it", async () => {
      // The lifecycle resolves no current Conversation. The schedule records a
      // pending lastRun but stays enabled/due for retry.
      const created = store.create({
        surface: dmSurface(999),
        kind: "recurring",
        prompt: "x",
        nextRunAt: new Date(NOW_MS - 1000).toISOString(),
        intervalMs: 3600_000,
      });
      const source = makeFakeLifecycle(null);

      const loop = new SchedulerLoop({ store, ...schedulerDependencies(source), dispatcher, clock: clock.clock, home: tmpDir });
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
      const unboundSource = makeFakeLifecycle(null);
      const unboundLoop = new SchedulerLoop({
        store,
        ...schedulerDependencies(unboundSource),
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });
      await unboundLoop.tick();

      expect(dispatcher.calls).toHaveLength(0);
      let after = store.getForSurface(loc, created.id);
      expect(after!.lastRun!.outcome).toBe("pending");
      expect(after!.enabled).toBe(true);

      // Rebind the Surface to a new Conversation and tick again.
      const reboundState: ConversationState = {
        id: "session-after-rebind",
        createdAt: new Date(NOW_MS).toISOString(),
        executionEnvironment: personalEnvironment(),
      };
      const boundSource = makeFakeLifecycle(reboundState);
      const boundLoop = new SchedulerLoop({
        store,
        ...schedulerDependencies(boundSource),
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
      });
      await boundLoop.tick();

      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.conversation.id).toBe("session-after-rebind");
      expect(dispatcher.calls[0]!.content).toBe("missed then rebound");
      after = store.getForSurface(loc, created.id);
      expect(after!.state).toBe("completed");
      expect(after!.enabled).toBe(false);
      expect(after!.lastRun!.outcome).toBe("ok");
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
      const source = makeFakeLifecycle(null);
      const loop = new SchedulerLoop({ store, ...schedulerDependencies(source), dispatcher, clock: clock.clock, home: tmpDir });

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
        runtimeAdmissionOpen: () => true,
        enqueueScheduledTurn: () => {
          throw new Error("boom");
        },
      };
      const loop = new SchedulerLoop({ store, ...schedulerDependencies(), dispatcher: throwingDispatcher, clock: clock.clock, home: tmpDir });

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
        runtimeAdmissionOpen: () => true,
        enqueueScheduledTurn: () => {
          throw new Error("sync boom");
        },
      };
      const loop = new SchedulerLoop({ store, ...schedulerDependencies(), dispatcher: throwingDispatcher, clock: clock.clock, home: tmpDir });

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
      const conversation = await createSession(loc);
      store.setHeartbeat({
        surface: loc,
        enabled: true,
        now: new Date(NOW_MS - 1800_000).toISOString(), // 30m ago → due now
      });
      return conversation.id;
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
      expect(dispatcher.calls[0]!.conversation.id).toBe(secondConv.id);
      expect(dispatcher.calls[0]!.conversation.id).not.toBe(firstSessionId);
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
        ...schedulerDependencies(),
        dispatcher,
        clock: clock.clock,
        // `home` only feeds resolveHeartbeatPrompt; persistence uses tmpDir.
        home: blockingFile,
      });

      // The tick must not reject, the heartbeat must not dispatch, and the
      // unrelated one-shot must still go through.
      await expect(loop.tick()).resolves.toBeUndefined();

      const dispatched = dispatcher.calls.map((c) => c.content);
      expect(dispatched).not.toContain("[heartbeat]");
      expect(dispatched).toEqual(["deploy reminder"]);

      // Prompt resolution happens before the claim, so a heartbeat read
      // failure does NOT advance or complete the schedule — it stays due for
      // the next tick. The failure is persisted as the occurrence's last-run
      // status rather than silently disappearing.
      const afterHeartbeat = store.getForSurface(heartbeatLoc, heartbeat.id)!;
      expect(afterHeartbeat.kind).toBe("heartbeat");
      expect(afterHeartbeat.enabled).toBe(true);
      expect(afterHeartbeat.state).toBe("enabled");
      expect(afterHeartbeat.nextRunAt).toBe(heartbeat.nextRunAt);
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
        runtimeAdmissionOpen: () => true,
        enqueueScheduledTurn(conversation, surface, content) {
          if (!firstSeen) {
            firstSeen = true;
            throw new Error("boom on first");
          }
          dispatcher.enqueueScheduledTurn(conversation, surface, content);
          return true;
        },
      };
      const loop = new SchedulerLoop({
        store,
        ...schedulerDependencies(),
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

  describe("Conversation enumeration for dreaming", () => {
    it("visits bound and unbound non-archived Conversations, excluding archived and internal state", async () => {
      const bound = await createSession(dmSurface(100));
      const unbound = conversationStore.create(personalEnvironment());
      const archived = conversationStore.create(personalEnvironment());
      conversationStore.archive(archived.id);
      const internal = internalSessionStore.ensure("__goblin_dreaming__");
      const visited: string[] = [];
      const memoryEngine = {
        dreaming: {
          runLightSleep: async (conversationId: string) => {
            visited.push(conversationId);
          },
        },
      } as unknown as MemoryEngine;
      const loop = new SchedulerLoop({
        store,
        ...schedulerDependencies(),
        dispatcher,
        clock: clock.clock,
        home: tmpDir,
        memoryEngine,
      });

      await (loop as unknown as { runDreamingLightSleep(): Promise<void> }).runDreamingLightSleep();

      expect(visited).toEqual(conversationStore.list().map((conversation) => conversation.id));
      expect(new Set(visited)).toEqual(new Set([bound.id, unbound.id]));
      expect(visited).not.toContain(archived.id);
      expect(visited).not.toContain(internal.id);
    });
  });

  describe("stop behavior", () => {
    it("drains admitted memory work without rearming an aligned timer after the stop fence closes", async () => {
      const transcriptSync = deferred<void>();
      const remSleep = deferred<void>();
      const timers: Array<{
        callback: () => void;
        ms: number;
        cleared: boolean;
        clear(): void;
      }> = [];
      const fakeClock: SchedulerClock = {
        now: () => NOW_MS,
        setInterval: (callback, ms) => {
          const timer = {
            callback,
            ms,
            cleared: false,
            clear: () => { timer.cleared = true; },
          };
          timers.push(timer);
          return timer;
        },
      };
      const tickIntervalMs = 101;
      const transcriptSyncIntervalMs = 202;
      const remRepeatIntervalMs = 86_400_123;
      let loop!: SchedulerLoop;
      let drain: Promise<void> | undefined;
      const memoryEngine = {
        syncTranscripts: () => transcriptSync.promise,
        dreaming: {
          runRemSleep: () => {
            // Close the fence from inside the aligned callback, after that
            // callback was admitted but before it can install its repeat timer.
            drain = loop.stopAndDrain();
            return remSleep.promise;
          },
        },
      } as unknown as MemoryEngine;
      loop = new SchedulerLoop({
        store,
        ...schedulerDependencies(),
        dispatcher,
        clock: fakeClock,
        home: tmpDir,
        memoryEngine,
        tickIntervalMs,
        transcriptSyncIntervalMs,
        dreamingLightIntervalMs: Number.POSITIVE_INFINITY,
        dreamingRemIntervalMs: remRepeatIntervalMs,
        dreamingDeepIntervalMs: Number.POSITIVE_INFINITY,
      });

      loop.start();
      timers.find((timer) => timer.ms === transcriptSyncIntervalMs)!.callback();
      const alignedTimer = timers.find(
        (timer) => timer.ms !== tickIntervalMs && timer.ms !== transcriptSyncIntervalMs,
      )!;
      alignedTimer.callback();

      expect(drain).toBeDefined();
      expect(timers.some((timer) => timer.ms === remRepeatIntervalMs)).toBe(false);
      expect(await Promise.race([
        drain!.then(() => "drained" as const),
        Promise.resolve("pending" as const),
      ])).toBe("pending");

      transcriptSync.resolve();
      expect(await Promise.race([
        drain!.then(() => "drained" as const),
        Promise.resolve("pending" as const),
      ])).toBe("pending");

      remSleep.resolve();
      await expect(drain!).resolves.toBeUndefined();
      expect(timers.every((timer) => timer.cleared)).toBe(true);
    });

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
        ...schedulerDependencies(),
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
        ...schedulerDependencies(),
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
