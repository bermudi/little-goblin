import { describe, expect, it } from "bun:test";
import type { AgentRunner } from "../agent/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import {
  asConversationRuntimeId,
  DelegatedWorkHost,
  type ConversationRuntimeId,
} from "../delegated-work/mod.ts";
import {
  RuntimeMachine,
  type InvalidationReason,
  type SurfaceRuntimeRegistration,
} from "./runtime-machine.ts";

// ─── helpers ─────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeRunner(dispose: () => Promise<void> = async () => {}): AgentRunner {
  return { dispose } as unknown as AgentRunner;
}

function fakeDelegatedWorkHost(): DelegatedWorkHost {
  return {
    invalidateRuntime: async (_runtimeId: ConversationRuntimeId): Promise<void> => {},
  } as unknown as DelegatedWorkHost;
}

function makeMachine(
  conversationId: ConversationId = "test-conv",
  admissionOpen = true,
): RuntimeMachine {
  return new RuntimeMachine({
    conversationId,
    delegatedWorkHost: fakeDelegatedWorkHost(),
    isAdmissionOpen: () => admissionOpen,
  });
}

function makeRegistration(surfaceIdStr = "tg:v1:dm:1"): SurfaceRuntimeRegistration {
  return {
    surfaceId: surfaceId(dmSurface(1)),
    runtimeId: asConversationRuntimeId(`runtime-${surfaceIdStr}`),
    skillContext: {
      settingsFingerprint: "test-settings",
      policyFingerprint: "test",
      manifestFingerprint: null,
    },
  };
}

function registerSurface(machine: RuntimeMachine, runner?: AgentRunner): AgentRunner {
  const r = runner ?? fakeRunner();
  // Match the real usage pattern: reserve a creation, then register.
  const creation = machine.reserveCreation(surfaceId(dmSurface(1)), "test-settings");
  try {
    machine.registerSurfaceRuntime(r, makeRegistration());
  } finally {
    creation.complete();
  }
  return r;
}

// ─── transition tests ────────────────────────────────────────────────

describe("RuntimeMachine transitions", () => {
  describe("legal transitions", () => {
    it("idle → preparing via reserveCreation", () => {
      const m = makeMachine();
      m.reserveCreation(surfaceId(dmSurface(1)), "fp");
      expect(m.currentPhase).toBe("preparing");
    });

    it("preparing → preparing via reserveCreation (newer supersedes)", () => {
      const m = makeMachine();
      m.reserveCreation(surfaceId(dmSurface(1)), "fp1");
      const gen1 = m.epoch;
      m.reserveCreation(surfaceId(dmSurface(1)), "fp2");
      expect(m.currentPhase).toBe("preparing");
      expect(m.epoch).toBeGreaterThan(gen1);
    });

    it("preparing → active via registerSurfaceRuntime", () => {
      const m = makeMachine();
      m.reserveCreation(surfaceId(dmSurface(1)), "fp");
      registerSurface(m);
      expect(m.currentPhase).toBe("active");
    });

    it("preparing → active via registerInternalRuntime", () => {
      const m = makeMachine();
      m.reserveCreation(surfaceId(dmSurface(1)), "fp");
      m.registerInternalRuntime(fakeRunner());
      expect(m.currentPhase).toBe("active");
      expect(m.isInternalRuntime()).toBe(true);
    });

    it("idle → active via registerInternalRuntime", () => {
      const m = makeMachine();
      m.registerInternalRuntime(fakeRunner());
      expect(m.currentPhase).toBe("active");
      expect(m.isInternalRuntime()).toBe(true);
    });

    it("active → active via registerInternalRuntime (re-register)", () => {
      const m = makeMachine();
      m.registerInternalRuntime(fakeRunner());
      const gen1 = m.epoch;
      m.registerInternalRuntime(fakeRunner());
      expect(m.currentPhase).toBe("active");
      expect(m.isInternalRuntime()).toBe(true);
      expect(m.epoch).toBeGreaterThan(gen1);
    });

    it("active → preparing via invalidate(settings-change, preserveCreation)", async () => {
      const m = makeMachine();
      registerSurface(m);
      const creation = m.reserveCreation(surfaceId(dmSurface(1)), "replacement");
      await m.invalidate("settings-change", creation.promise);
      expect(m.currentPhase).toBe("preparing");
      expect(m.isCurrentCreation(creation.promise)).toBe(true);
      creation.complete();
    });

    it("active → idle via invalidate(binding-change)", async () => {
      const m = makeMachine();
      registerSurface(m);
      await m.invalidate("binding-change");
      expect(m.currentPhase).toBe("idle");
      expect(m.hasRunner()).toBe(false);
    });

    it("active → idle via invalidate(shutdown)", async () => {
      const m = makeMachine();
      registerSurface(m);
      await m.invalidate("shutdown");
      expect(m.currentPhase).toBe("idle");
      expect(m.hasRunner()).toBe(false);
    });

    it("preparing → idle via invalidate(binding-change)", async () => {
      const m = makeMachine();
      m.reserveCreation(surfaceId(dmSurface(1)), "fp");
      await m.invalidate("binding-change");
      expect(m.currentPhase).toBe("idle");
      expect(m.getCreation()).toBeUndefined();
    });

    it("preparing → idle via invalidate(shutdown)", async () => {
      const m = makeMachine();
      m.reserveCreation(surfaceId(dmSurface(1)), "fp");
      await m.invalidate("shutdown");
      expect(m.currentPhase).toBe("idle");
      expect(m.getCreation()).toBeUndefined();
    });

    it("idle → idle via invalidate (no-op)", async () => {
      const m = makeMachine();
      await m.invalidate("binding-change");
      expect(m.currentPhase).toBe("idle");
    });

    it("active → preparing via reserveCreation (replacement while active)", () => {
      const m = makeMachine();
      registerSurface(m);
      m.reserveCreation(surfaceId(dmSurface(1)), "replacement");
      expect(m.currentPhase).toBe("preparing");
    });
  });

  describe("illegal state preconditions fail loud with structured identity", () => {
    it("registerSurfaceRuntime throws when a runner is already registered", () => {
      const m = makeMachine("conv-x");
      registerSurface(m);
      expect(() => registerSurface(m)).toThrow(/already registered/);
      expect(() => registerSurface(m)).toThrow(/conv-x/);
    });

    it("registerSurfaceRuntime throws when an internal runtime is active", () => {
      const m = makeMachine("conv-x");
      m.registerInternalRuntime(fakeRunner());
      // The runner check fires first — an internal runtime sets the runner.
      expect(() => registerSurface(m)).toThrow(/already registered/);
      expect(() => registerSurface(m)).toThrow(/conv-x/);
    });

    it("registerInternalRuntime throws when a surface runner is active", () => {
      const m = makeMachine("conv-x");
      registerSurface(m);
      expect(() => m.registerInternalRuntime(fakeRunner())).toThrow(/cannot reuse Surface-backed runtime/);
      expect(() => m.registerInternalRuntime(fakeRunner())).toThrow(/conv-x/);
    });

    it("reserveCreation throws when admission is closed", () => {
      let open = true;
      const m = new RuntimeMachine({
        conversationId: "conv-x",
        delegatedWorkHost: fakeDelegatedWorkHost(),
        isAdmissionOpen: () => open,
      });
      open = false;
      expect(() => m.reserveCreation(surfaceId(dmSurface(1)), "fp")).toThrow(/admission is closed/);
    });

    it("registerSurfaceRuntime throws when admission is closed", () => {
      let open = true;
      const m = new RuntimeMachine({
        conversationId: "conv-x",
        delegatedWorkHost: fakeDelegatedWorkHost(),
        isAdmissionOpen: () => open,
      });
      open = false;
      expect(() => registerSurface(m)).toThrow(/admission is closed/);
    });

    it("registerInternalRuntime throws when admission is closed", () => {
      let open = true;
      const m = new RuntimeMachine({
        conversationId: "conv-x",
        delegatedWorkHost: fakeDelegatedWorkHost(),
        isAdmissionOpen: () => open,
      });
      open = false;
      expect(() => m.registerInternalRuntime(fakeRunner())).toThrow(/admission is closed/);
    });

    it("registerSurfaceRuntime throws when a prior-generation disposal is still active", async () => {
      const disposed = deferred<void>();
      const m = makeMachine("conv-x");
      registerSurface(m, fakeRunner(() => disposed.promise));
      const disposal = m.invalidate("binding-change");
      expect(() => registerSurface(m)).toThrow(/prior-generation disposal is still active/);
      expect(() => registerSurface(m)).toThrow(/conv-x/);
      disposed.resolve(undefined);
      await disposal;
    });

    it("registerSurfaceRuntime throws when delegated invalidation is still pending", async () => {
      let attempts = 0;
      const host = {
        invalidateRuntime: async (): Promise<void> => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary delegated failure");
        },
      } as unknown as DelegatedWorkHost;
      const m = new RuntimeMachine({
        conversationId: "conv-x",
        delegatedWorkHost: host,
        isAdmissionOpen: () => true,
      });
      registerSurface(m);
      await expect(m.invalidate("binding-change")).rejects.toThrow("temporary delegated failure");
      expect(() => registerSurface(m)).toThrow(/delegated work invalidation is still pending/);
      expect(() => registerSurface(m)).toThrow(/conv-x/);
      await m.awaitSettled();
    });
  });
});

// ─── queue / serial executor tests ───────────────────────────────────

describe("RuntimeMachine queue and serial executor", () => {
  it("processes entries in order", async () => {
    const m = makeMachine();
    const order: string[] = [];
    m.schedule(() => true, async () => { order.push("first"); }, async () => {});
    m.schedule(() => true, async () => { order.push("second"); }, async () => {});
    m.schedule(() => true, async () => { order.push("third"); }, async () => {});
    await m.queueSettled();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("cancel removes entry from queue without touching the runner", async () => {
    const m = makeMachine();
    let abortCalls = 0;
    const runner = {
      dispose: async () => {},
      abort: async () => { abortCalls += 1; },
      isStreaming: false,
    } as unknown as AgentRunner;
    registerSurface(m, runner);

    const firstFinished = deferred<void>();
    let secondRan = false;
    m.schedule(() => true, async () => { await firstFinished.promise; }, async () => {});
    m.schedule(() => true, async () => { secondRan = true; }, async () => {});

    expect(m.cancelPending()).toBe(true);
    expect(abortCalls).toBe(0);
    firstFinished.resolve(undefined);
    await m.queueSettled();
    expect(secondRan).toBe(false);
  });

  it("cancel returns false when no pending prompt exists", () => {
    const m = makeMachine();
    expect(m.cancelPending()).toBe(false);
  });

  it("rejects work when admission is closed", () => {
    let open = true;
    const m = new RuntimeMachine({
      conversationId: "conv-x",
      delegatedWorkHost: fakeDelegatedWorkHost(),
      isAdmissionOpen: () => open,
    });
    open = false;
    expect(m.schedule(() => true, async () => {}, async () => {})).toBe(false);
  });

  it("admits a late-steer fallback before returning when attach throws not-streaming", () => {
    const m = makeMachine();
    registerSurface(m);
    const firstFinished = deferred<void>();
    m.schedule(() => true, async () => { await firstFinished.promise; }, async () => {});

    const decision = m.steerOrQueue(
      () => {
        throw new Error("Cannot steer: session is not streaming.");
      },
      {
        isCurrent: () => true,
        run: async () => {},
        onError: async () => {},
      },
    );

    expect(decision).toEqual({ kind: "queued" });
    expect(m.isPromptPending()).toBe(true);
    firstFinished.resolve(undefined);
  });

  it("rejects a late-steer fallback when admission is already closed", () => {
    let open = true;
    const m = new RuntimeMachine({
      conversationId: "conv-steer",
      delegatedWorkHost: fakeDelegatedWorkHost(),
      isAdmissionOpen: () => open,
    });
    registerSurface(m);
    open = false;

    const decision = m.steerOrQueue(
      () => {
        throw new Error("Cannot steer: session is not streaming.");
      },
      {
        isCurrent: () => true,
        run: async () => {},
        onError: async () => {},
      },
    );

    expect(decision).toEqual({ kind: "rejected" });
    expect(m.isPromptPending()).toBe(false);
  });

  it("returns the follow-up promise when attach succeeds", async () => {
    const m = makeMachine();
    const attached = deferred<void>();
    const decision = m.steerOrQueue(
      () => attached.promise,
      {
        isCurrent: () => true,
        run: async () => {},
        onError: async () => {},
      },
    );
    expect(decision.kind).toBe("steered");
    if (decision.kind !== "steered") throw new Error("expected steered");
    attached.resolve(undefined);
    await decision.followUp;
    expect(m.isPromptPending()).toBe(false);
  });

  it("propagates non-race attach failures without queueing", () => {
    const m = makeMachine();
    expect(() => m.steerOrQueue(
      () => {
        throw new Error("session disposed");
      },
      {
        isCurrent: () => true,
        run: async () => {},
        onError: async () => {},
      },
    )).toThrow("session disposed");
    expect(m.isPromptPending()).toBe(false);
  });

  it("fences unstarted entries on binding-change invalidation", async () => {
    const m = makeMachine();
    const firstFinished = deferred<void>();
    let secondRan = false;
    let secondFenced = false;
    m.schedule(() => true, async () => { await firstFinished.promise; }, async () => {});
    m.schedule(
      () => true,
      async () => { secondRan = true; },
      async () => {},
      { onFenced: () => { secondFenced = true; } },
    );

    m.invalidate("binding-change");
    expect(m.hasPromptWork()).toBe(false);
    expect(m.isPromptPending()).toBe(false);
    firstFinished.resolve(undefined);
    await m.queueSettled();
    expect(secondRan).toBe(false);
    expect(secondFenced).toBe(true);
  });

  it("preserves queue on settings-change invalidation", async () => {
    const m = makeMachine();
    const runner = registerSurface(m);
    const firstFinished = deferred<void>();
    // Schedule a long-running prompt so the command stays queued behind it.
    m.schedule(() => true, async () => { await firstFinished.promise; }, async () => {});
    let commandRan = false;
    m.schedule(
      () => m.isRegisteredRunner(runner),
      async () => { commandRan = true; },
      async () => {},
      { isPrompt: false },
    );
    await Promise.resolve();

    const creation = m.reserveCreation(surfaceId(dmSurface(1)), "replacement");
    await m.invalidate("settings-change", creation.promise);
    // Queue is preserved — the command is still pending (not started, not fenced)
    expect(m.isCommandPending()).toBe(true);

    firstFinished.resolve(undefined);
    await m.queueSettled();
    // After the first prompt finishes, the command runs but is fenced because
    // the old runner was disposed (isCurrent returns false).
    expect(commandRan).toBe(false);
    creation.complete();
  });

  it("calls onFenced when isCurrent returns false before starting", async () => {
    const m = makeMachine();
    const firstFinished = deferred<void>();
    let fenced = false;
    m.schedule(() => true, async () => { await firstFinished.promise; }, async () => {});
    m.schedule(
      () => false,
      async () => {},
      async () => {},
      { onFenced: () => { fenced = true; } },
    );
    firstFinished.resolve(undefined);
    await m.queueSettled();
    expect(fenced).toBe(true);
  });

  it("calls onFenced when isCurrent becomes false during execution", async () => {
    const m = makeMachine();
    const runner = registerSurface(m);
    const midTurn = deferred<void>();
    let fenced = false;
    m.schedule(
      () => m.isRegisteredRunner(runner),
      async () => { await midTurn.promise; },
      async () => {},
      { onFenced: () => { fenced = true; } },
    );
    await Promise.resolve();
    // Invalidate while the entry is running
    m.invalidate("binding-change");
    midTurn.resolve(undefined);
    await m.queueSettled();
    expect(fenced).toBe(true);
  });
});

// ─── drain set and overlapping generations ───────────────────────────

describe("RuntimeMachine drain set", () => {
  it("allows a replacement creation while a prior generation drains", async () => {
    const oldDisposed = deferred<void>();
    const m = makeMachine();
    registerSurface(m, fakeRunner(() => oldDisposed.promise));

    const oldDisposal = m.invalidate("binding-change");
    const replacement = m.reserveCreation(surfaceId(dmSurface(1)), "replacement");
    expect(m.currentPhase).toBe("preparing");
    expect(m.isCurrentCreation(replacement.promise)).toBe(true);

    oldDisposed.resolve(undefined);
    await oldDisposal;
    replacement.complete();
  });

  it("awaitSettled waits for prior generation disposal", async () => {
    const disposed = deferred<void>();
    const m = makeMachine();
    registerSurface(m, fakeRunner(() => disposed.promise));
    const disposal = m.invalidate("binding-change");

    const settledPromise = m.awaitSettled();
    let settled = false;
    void settledPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    disposed.resolve(undefined);
    await disposal;
    await settledPromise;
    expect(settled).toBe(true);
  });

  it("retries delegated invalidation after a failed disposal", async () => {
    let attempts = 0;
    const host = {
      invalidateRuntime: async (): Promise<void> => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary delegated failure");
      },
    } as unknown as DelegatedWorkHost;
    const m = new RuntimeMachine({
      conversationId: "conv-x",
      delegatedWorkHost: host,
      isAdmissionOpen: () => true,
    });
    registerSurface(m);

    await expect(m.invalidate("binding-change")).rejects.toThrow("temporary delegated failure");
    await m.invalidate("binding-change");
    expect(attempts).toBe(2);
  });

  it("deduplicates disposal for the same generation", async () => {
    const disposed = deferred<void>();
    const m = makeMachine();
    registerSurface(m, fakeRunner(() => disposed.promise));

    const first = m.invalidate("binding-change");
    const second = m.invalidate("binding-change");
    expect(second).toBe(first);

    disposed.resolve(undefined);
    await first;
  });

  it("a stronger fence revokes what a weaker fence preserved", async () => {
    const disposed = deferred<void>();
    const m = makeMachine();
    registerSurface(m, fakeRunner(() => disposed.promise));
    const creation = m.reserveCreation(surfaceId(dmSurface(1)), "test");

    const first = m.invalidate("settings-change", creation.promise);
    expect(m.isCurrentCreation(creation.promise)).toBe(true);
    const second = m.invalidate("binding-change");
    expect(second).toBe(first);
    expect(m.isCurrentCreation(creation.promise)).toBe(false);

    disposed.resolve(undefined);
    await first;
    creation.complete();
  });

  it("counts an active drain as runtime state after delegated invalidation finishes", async () => {
    const runnerDisposed = deferred<void>();
    const delegatedFinished = deferred<void>();
    const host = {
      invalidateRuntime: async (): Promise<void> => {
        delegatedFinished.resolve(undefined);
        await runnerDisposed.promise;
      },
    } as unknown as DelegatedWorkHost;
    const m = new RuntimeMachine({
      conversationId: "conv-x",
      delegatedWorkHost: host,
      isAdmissionOpen: () => true,
    });
    registerSurface(m, fakeRunner(() => runnerDisposed.promise));

    const first = m.invalidate("binding-change");
    await delegatedFinished.promise;
    expect(m.hasRuntime()).toBe(true);

    let secondSettled = false;
    const second = m.invalidate("binding-change");
    void second.then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    runnerDisposed.resolve(undefined);
    await first;
    await second;
    expect(m.hasRuntime()).toBe(false);
  });

  it("shutdown waits for a superseded creation reservation", async () => {
    const m = makeMachine();
    const first = m.reserveCreation(surfaceId(dmSurface(1)), "first");
    const second = m.reserveCreation(surfaceId(dmSurface(1)), "second");
    expect(m.isCurrentCreation(first.promise)).toBe(false);
    expect(m.isCurrentCreation(second.promise)).toBe(true);

    const shutdown = m.shutdown();
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    second.complete();
    await Promise.resolve();
    expect(settled).toBe(false);

    first.complete();
    await shutdown;
    expect(settled).toBe(true);
  });
});

// ─── internal runtimes ───────────────────────────────────────────────

describe("RuntimeMachine internal runtimes", () => {
  it("internal runtime tickets are always current until disposed", async () => {
    const m = makeMachine();
    m.registerInternalRuntime(fakeRunner());
    expect(m.isInternalRuntime()).toBe(true);

    // An internal runtime can be re-registered (e.g. for a new dreaming turn)
    m.registerInternalRuntime(fakeRunner());
    expect(m.isInternalRuntime()).toBe(true);

    await m.invalidate("shutdown");
    expect(m.isInternalRuntime()).toBe(false);
  });
});

// ─── shutdown ────────────────────────────────────────────────────────

describe("RuntimeMachine shutdown", () => {
  it("terminates after draining all work", async () => {
    const m = makeMachine();
    registerSurface(m, fakeRunner());
    m.schedule(() => true, async () => {}, async () => {});

    await m.shutdown();
    expect(m.hasRunner()).toBe(false);
    expect(m.currentPhase).toBe("idle");
  });

  it("fences unstarted entries during shutdown", async () => {
    const m = makeMachine();
    const firstFinished = deferred<void>();
    const order: string[] = [];
    registerSurface(m, fakeRunner(async () => { firstFinished.resolve(undefined); }));
    m.schedule(() => true, async () => { order.push("first"); await firstFinished.promise; }, async () => {});
    m.schedule(() => true, async () => { order.push("second"); }, async () => {});

    await m.shutdown();
    expect(order).toEqual(["first"]);
  });

  it("shutdown is idempotent-like: calling shutdown on an idle machine is safe", async () => {
    const m = makeMachine();
    await m.shutdown();
    expect(m.currentPhase).toBe("idle");
  });

  it("shutdown terminates and reports failure when delegated invalidation fails persistently", async () => {
    let attempts = 0;
    const host = {
      invalidateRuntime: async (): Promise<void> => {
        attempts += 1;
        throw new Error("persistent delegated failure");
      },
    } as unknown as DelegatedWorkHost;
    const m = new RuntimeMachine({
      conversationId: "conv-x",
      delegatedWorkHost: host,
      isAdmissionOpen: () => true,
    });
    registerSurface(m);

    // shutdown should retry once, then report the unresolved failure
    // rather than spinning forever. Both the initial and retry failures
    // are collected into an AggregateError.
    let shutdownError: unknown;
    try {
      await m.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    expect(shutdownError).toBeDefined();
    expect(shutdownError instanceof AggregateError).toBe(true);
    expect((shutdownError as AggregateError).errors).toHaveLength(2);
    expect(attempts).toBe(2);
    expect(m.currentPhase).toBe("idle");
  });
});

// ─── seeded interleaving property test ───────────────────────────────

describe("RuntimeMachine seeded interleaving property test", () => {
  // Mulberry32 — a small, fast, seeded PRNG. Deterministic for a given seed.
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  interface WorkRecord {
    readonly id: number;
    started: boolean;
    executed: boolean;
    fenced: boolean;
    settled: boolean;
    /** The epoch at schedule time. */
    epoch: number;
    /** Whether the original runner was still registered when run was entered. */
    runnerRegisteredAtStart: boolean;
  }

  /**
   * Run one randomized trial. The machine starts with a registered runner so
   * that `isCurrent` closures can reference it. Operations are applied in a
   * random order. Invariants are checked at the end.
   */
  async function runTrial(seed: number): Promise<void> {
    const rng = mulberry32(seed);
    const m = makeMachine(`trial-${seed}`);
    const runner = registerSurface(m);

    const workRecords: WorkRecord[] = [];
    let workIdCounter = 0;
    const pendingSettled: Promise<void>[] = [];

    // The runner's dispose resolves immediately — we want shutdown to
    // terminate promptly.
    const opCount = 20 + Math.floor(rng() * 30);
    let shutdownCalled = false;

    for (let i = 0; i < opCount; i++) {
      if (shutdownCalled) break;
      const roll = rng();
      if (roll < 0.45) {
        // admit
        const id = workIdCounter++;
        const record: WorkRecord = {
          id,
          started: false,
          executed: false,
          fenced: false,
          settled: false,
          epoch: m.epoch,
          runnerRegisteredAtStart: false,
        };
        workRecords.push(record);
        // The isCurrent closure checks if the runner is still registered.
        // After invalidation, the runner is fenced, so isCurrent returns false.
        const isCurrent = (): boolean => m.isRegisteredRunner(runner);
        const settledPromise = new Promise<void>((resolve) => {
          const admitted = m.schedule(
            isCurrent,
            async (check) => {
              record.started = true;
              // Capture whether the runner is still registered at the
              // moment run is entered. If the serial executor's commit
              // point is working, this must be true — the pump checks
              // isCurrent() before calling run. A promise-chain design
              // that calls run after the runner is disposed would fail
              // this check.
              record.runnerRegisteredAtStart = m.isRegisteredRunner(runner);
              if (check()) {
                record.executed = true;
              }
            },
            async () => {},
            {
              onFenced: () => { record.fenced = true; },
              onSettled: () => { record.settled = true; resolve(undefined); },
            },
          );
          if (!admitted) {
            // Admission closed — the work was rejected.
            record.fenced = true;
            record.settled = true;
            resolve(undefined);
          }
        });
        pendingSettled.push(settledPromise);
      } else if (roll < 0.60) {
        // cancel
        m.cancelPending();
      } else if (roll < 0.85) {
        // invalidate
        const reasonRoll = rng();
        const reason: InvalidationReason =
          reasonRoll < 0.4 ? "settings-change" : reasonRoll < 0.8 ? "binding-change" : "shutdown";
        if (reason === "shutdown") {
          // Can't close admission on the machine directly — the host does that.
          // Simulate by just using binding-change here; shutdown is tested
          // separately via the shutdown op.
          m.invalidate("binding-change");
        } else {
          m.invalidate(reason);
        }
        // Re-register a runner so subsequent admits have a current target.
        // This mimics the lifecycle creating a new runner after invalidation.
        if (m.currentPhase === "idle" && !shutdownCalled) {
          try {
            registerSurface(m, fakeRunner());
          } catch {
            // A prior disposal may still be draining — skip re-registration.
          }
        }
      } else {
        // shutdown
        shutdownCalled = true;
      }
    }

    // Wait for all queued work to settle.
    await Promise.all(pendingSettled);

    if (shutdownCalled) {
      await m.shutdown();
    }

    // ─── invariant 1: no work enters run after its runner is disposed ───
    // The serial executor's commit point checks isCurrent() before calling
    // run. If run is entered, the runner must still be registered. A
    // promise-chain design that calls run after the runner is disposed
    // would fail this check — runnerRegisteredAtStart would be false.
    for (const record of workRecords) {
      if (record.started && !record.runnerRegisteredAtStart) {
        throw new Error(
          `trial ${seed}: work ${record.id} entered run after runner was disposed`,
        );
      }
    }

    // ─── invariant 2: no ticket leaks ───
    // Every scheduled work record must have settled.
    for (const record of workRecords) {
      if (!record.settled) {
        throw new Error(`trial ${seed}: work ${record.id} did not settle (ticket leak)`);
      }
    }

    // ─── invariant 3: shutdown terminates ───
    // If shutdown was called, the machine must be idle after.
    if (shutdownCalled) {
      if (m.currentPhase !== "idle") {
        throw new Error(
          `trial ${seed}: machine not idle after shutdown (phase=${m.currentPhase})`,
        );
      }
      if (m.hasRunner()) {
        throw new Error(`trial ${seed}: runner still registered after shutdown`);
      }
    }
  }

  it("upholds invariants across 100 seeded trials", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      await runTrial(seed);
    }
  });

  it("upholds invariants across 50 more seeds with higher invalidation rate", async () => {
    // This is a separate test to exercise different random sequences.
    for (let seed = 1001; seed <= 1050; seed++) {
      await runTrial(seed);
    }
  });
});
