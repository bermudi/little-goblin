import { describe, expect, it } from "bun:test";
import { RunnerNotStreamingError, type AgentRunner } from "../agent/mod.ts";
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
  type WorkIntent,
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

async function settlesWithin(promise: Promise<void>, timeoutMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`operation did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    m.schedule({ kind: "binding" }, async () => { order.push("first"); }, async () => {});
    m.schedule({ kind: "binding" }, async () => { order.push("second"); }, async () => {});
    m.schedule({ kind: "binding" }, async () => { order.push("third"); }, async () => {});
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
    m.schedule({ kind: "binding" }, async () => { await firstFinished.promise; }, async () => {});
    m.schedule({ kind: "binding" }, async () => { secondRan = true; }, async () => {});

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
    expect(m.schedule({ kind: "binding" }, async () => {}, async () => {})).toBe(false);
  });

  it("admits a late-steer fallback before returning when attach throws not-streaming", () => {
    const m = makeMachine();
    registerSurface(m);
    const firstFinished = deferred<void>();
    m.schedule({ kind: "binding" }, async () => { await firstFinished.promise; }, async () => {});

    const decision = m.steerOrQueue(
      () => {
        throw new RunnerNotStreamingError();
      },
      {
        intent: { kind: "binding" },
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
        throw new RunnerNotStreamingError();
      },
      {
        intent: { kind: "binding" },
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
        intent: { kind: "binding" },
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
        intent: { kind: "binding" },
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
    m.schedule({ kind: "binding" }, async () => { await firstFinished.promise; }, async () => {});
    m.schedule(
      { kind: "binding" },
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

  it("preserves binding-authority commands on settings-change invalidation", async () => {
    const m = makeMachine();
    registerSurface(m);
    const firstFinished = deferred<void>();
    // Schedule a long-running prompt so the command stays queued behind it.
    m.schedule({ kind: "binding" }, async () => { await firstFinished.promise; }, async () => {});
    let commandRan = false;
    m.schedule(
      { kind: "binding" },
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
    // Binding authority survives same-binding runtime replacement.
    expect(commandRan).toBe(true);
    creation.complete();
  });

  it("fences work whose declared runtime is not current before starting", async () => {
    const m = makeMachine();
    registerSurface(m);
    const staleRunner = fakeRunner();
    const firstFinished = deferred<void>();
    let fenced = 0;
    let settled = 0;
    m.schedule({ kind: "binding" }, async () => { await firstFinished.promise; }, async () => {});
    m.schedule(
      { kind: "current-runtime", runner: staleRunner },
      async () => {},
      async () => {},
      {
        onFenced: () => { fenced += 1; },
        onSettled: () => { settled += 1; },
      },
    );
    firstFinished.resolve(undefined);
    await m.queueSettled();
    expect(fenced).toBe(1);
    expect(settled).toBe(1);
  });

  it("calls onFenced when machine-held authority becomes stale during execution", async () => {
    const m = makeMachine();
    const runner = registerSurface(m);
    const midTurn = deferred<void>();
    let fenced = false;
    m.schedule(
      { kind: "current-runtime", runner },
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

describe("RuntimeMachine immediate runtime admission", () => {
  it("atomically accepts one idle cold turn and classifies a concurrent turn busy", async () => {
    const m = makeMachine();
    const started = deferred<void>();
    const release = deferred<void>();
    let runnerAtAdmission: AgentRunner | null | undefined;
    const first = m.admitImmediateRuntimeWork(async (context) => {
      runnerAtAdmission = context.runnerAtAdmission;
      started.resolve(undefined);
      await release.promise;
      return { kind: "completed" };
    });
    const second = m.admitImmediateRuntimeWork(async () => ({ kind: "completed" }));

    expect(first.kind).toBe("accepted");
    expect(second).toEqual({ kind: "busy" });
    await started.promise;
    expect(runnerAtAdmission).toBeNull();
    release.resolve(undefined);
    if (first.kind !== "accepted") throw new Error("expected accepted admission");
    expect(await first.settlement).toEqual({ kind: "completed" });
  });

  it("reports busy for any active prompt or command entry", async () => {
    for (const isPrompt of [true, false]) {
      const m = makeMachine();
      const release = deferred<void>();
      m.schedule(
        { kind: "binding" },
        async () => { await release.promise; },
        async () => {},
        { isPrompt },
      );
      expect(m.admitImmediateRuntimeWork(async () => ({ kind: "completed" })))
        .toEqual({ kind: "busy" });
      release.resolve(undefined);
      await m.queueSettled();
    }
  });

  it("holds a warm admission to its runner and fences it after invalidation", async () => {
    const m = makeMachine();
    const runner = registerSurface(m);
    const started = deferred<void>();
    const release = deferred<void>();
    const admission = m.admitImmediateRuntimeWork(async (context) => {
      expect(context.runnerAtAdmission).toBe(runner);
      started.resolve(undefined);
      await release.promise;
      return { kind: "completed" };
    });
    if (admission.kind !== "accepted") throw new Error("expected accepted admission");
    await started.promise;
    const invalidation = m.invalidate("binding-change");
    release.resolve(undefined);
    await invalidation;
    expect(await admission.settlement).toEqual({ kind: "fenced" });
  });

  it("settles explicit fences and current failures structurally", async () => {
    const m = makeMachine();
    const explicitlyFenced = m.admitImmediateRuntimeWork(async () => ({ kind: "fenced" }));
    if (explicitlyFenced.kind !== "accepted") throw new Error("expected accepted admission");
    expect(await explicitlyFenced.settlement).toEqual({ kind: "fenced" });

    const failure = new Error("immediate failure");
    const failed = m.admitImmediateRuntimeWork(async () => { throw failure; });
    if (failed.kind !== "accepted") throw new Error("expected accepted admission");
    expect(await failed.settlement).toEqual({ kind: "failed", error: failure });
  });

  it("returns closed or fenced without installing work", () => {
    const closed = makeMachine("closed", false);
    expect(closed.admitImmediateRuntimeWork(async () => ({ kind: "completed" })))
      .toEqual({ kind: "closed" });

    const internal = makeMachine("internal");
    internal.registerInternalRuntime(fakeRunner());
    expect(internal.admitImmediateRuntimeWork(async () => ({ kind: "completed" })))
      .toEqual({ kind: "fenced" });
  });

  it("bounds shutdown while accepted immediate work is blocked", async () => {
    const releasedByDispose = deferred<void>();
    const runner = fakeRunner(async () => { releasedByDispose.resolve(undefined); });
    const m = makeMachine();
    registerSurface(m, runner);
    const started = deferred<void>();
    const admission = m.admitImmediateRuntimeWork(async () => {
      started.resolve(undefined);
      await releasedByDispose.promise;
      return { kind: "completed" };
    });
    if (admission.kind !== "accepted") throw new Error("expected accepted admission");
    await started.promise;

    await settlesWithin(m.shutdown());
    expect(await admission.settlement).toEqual({ kind: "fenced" });
    expect(m.currentPhase).toBe("idle");
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
  it("replacing an internal registration fences tickets from the prior registration", async () => {
    const m = makeMachine();
    const prior = fakeRunner();
    m.registerInternalRuntime(prior);
    const release = deferred<void>();
    let priorFenced = false;
    m.schedule(
      { kind: "internal-runtime", runner: prior },
      async () => { await release.promise; },
      async () => {},
      { onFenced: () => { priorFenced = true; } },
    );
    await Promise.resolve();

    const replacement = fakeRunner();
    m.registerInternalRuntime(replacement);
    release.resolve(undefined);
    await m.queueSettled();

    expect(priorFenced).toBe(true);
    expect(m.isRegisteredRunner(replacement)).toBe(true);
  });

  it("disposes replaced and current internal runners so blocked work and shutdown terminate", async () => {
    const m = makeMachine();
    const promptStarted = deferred<void>();
    const disposedA = deferred<void>();
    let disposeA = 0;
    let disposeB = 0;
    let fenced = 0;
    let settled = 0;
    let postFenceEffects = 0;

    const runnerA = {
      prompt: async (): Promise<void> => {
        promptStarted.resolve(undefined);
        await disposedA.promise;
      },
      dispose: async (): Promise<void> => {
        disposeA += 1;
        disposedA.resolve(undefined);
      },
    } as unknown as AgentRunner;
    const runnerB = {
      dispose: async (): Promise<void> => { disposeB += 1; },
    } as unknown as AgentRunner;

    m.registerInternalRuntime(runnerA);
    m.schedule(
      { kind: "internal-runtime", runner: runnerA },
      async (authority) => {
        await runnerA.prompt("blocked", {} as never);
        if (authority.isCurrent()) postFenceEffects += 1;
      },
      async () => {},
      {
        onFenced: () => { fenced += 1; },
        onSettled: () => { settled += 1; },
      },
    );
    await promptStarted.promise;

    m.registerInternalRuntime(runnerB);
    expect(m.isRegisteredRunner(runnerB)).toBe(true);

    await settlesWithin(m.shutdown());
    expect(disposeA).toBe(1);
    expect(disposeB).toBe(1);
    expect(postFenceEffects).toBe(0);
    expect(fenced).toBe(1);
    expect(settled).toBe(1);
    expect(m.currentPhase).toBe("idle");
  });

  it("reports a replaced internal runner disposal failure during shutdown", async () => {
    const m = makeMachine();
    const cleanupFailure = new Error("internal replacement cleanup failed");
    m.registerInternalRuntime(fakeRunner(async () => { throw cleanupFailure; }));
    m.registerInternalRuntime(fakeRunner());

    await expect(m.shutdown()).rejects.toThrow("internal replacement cleanup failed");
  });

  it("bootstrap authority survives creation and adopts the registered runner", async () => {
    const m = makeMachine();
    const creationStarted = deferred<void>();
    const runnerReady = deferred<void>();
    let adopted = false;
    let currentAfterAdoption = false;

    m.schedule(
      { kind: "bootstrap" },
      async (authority) => {
        creationStarted.resolve(undefined);
        await runnerReady.promise;
        const runner = m.getRunner();
        if (runner === null) throw new Error("runner not registered");
        adopted = authority.adoptCurrentRunner(runner);
        currentAfterAdoption = authority.isCurrent();
      },
      async () => {},
    );
    await creationStarted.promise;

    const runner = fakeRunner();
    registerSurface(m, runner);
    runnerReady.resolve(undefined);
    await m.queueSettled();

    expect(adopted).toBe(true);
    expect(currentAfterAdoption).toBe(true);
  });
});

// ─── shutdown ────────────────────────────────────────────────────────

describe("RuntimeMachine shutdown", () => {
  it("terminates after draining all work", async () => {
    const m = makeMachine();
    registerSurface(m, fakeRunner());
    m.schedule({ kind: "binding" }, async () => {}, async () => {});

    await m.shutdown();
    expect(m.hasRunner()).toBe(false);
    expect(m.currentPhase).toBe("idle");
  });

  it("fences unstarted entries during shutdown", async () => {
    const m = makeMachine();
    const firstFinished = deferred<void>();
    const order: string[] = [];
    registerSurface(m, fakeRunner(async () => { firstFinished.resolve(undefined); }));
    m.schedule({ kind: "binding" }, async () => { order.push("first"); await firstFinished.promise; }, async () => {});
    m.schedule({ kind: "binding" }, async () => { order.push("second"); }, async () => {});

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

  interface ControlledGate {
    readonly promise: Promise<void>;
    readonly release: () => void;
    readonly isReleased: () => boolean;
  }

  function controlledGate(): ControlledGate {
    const control = deferred<void>();
    let released = false;
    return {
      promise: control.promise,
      release: () => {
        if (released) return;
        released = true;
        control.resolve(undefined);
      },
      isReleased: () => released,
    };
  }

  interface TrackedRunner {
    readonly runner: AgentRunner;
    readonly gate: ControlledGate;
    disposeCalls: number;
  }

  function trackedRunner(): TrackedRunner {
    const gate = controlledGate();
    let tracked!: TrackedRunner;
    const runner = {
      dispose: async () => {
        tracked.disposeCalls += 1;
        gate.release();
      },
    } as unknown as AgentRunner;
    tracked = { runner, gate, disposeCalls: 0 };
    return tracked;
  }

  interface WorkRecord {
    readonly intent: WorkIntent["kind"];
    readonly settledPromise: Promise<void>;
    readonly startedPromise: Promise<void>;
    runCount: number;
    fencedCount: number;
    settledCount: number;
    errorCount: number;
    effects: number;
    staleAfterAwait: boolean;
    adopted: boolean;
  }

  async function runTrial(seed: number): Promise<void> {
    const rng = mulberry32(seed);
    const m = makeMachine(`trial-${seed}`);
    const runners: TrackedRunner[] = [];
    const manualGates: ControlledGate[] = [];
    const records: WorkRecord[] = [];
    const seenIntents = new Set<WorkIntent["kind"]>();

    const createAndTrackRunner = (): TrackedRunner => {
      const tracked = trackedRunner();
      runners.push(tracked);
      return tracked;
    };

    let current = createAndTrackRunner();
    m.registerInternalRuntime(current.runner);

    const admit = (kind: WorkIntent["kind"]): WorkRecord => {
      const settledControl = deferred<void>();
      const startedControl = deferred<void>();
      const manualGate = kind === "binding" ? controlledGate() : undefined;
      if (manualGate !== undefined) manualGates.push(manualGate);
      const admissionRunner = current;
      const intent: WorkIntent = kind === "binding" || kind === "bootstrap"
        ? { kind }
        : { kind, runner: admissionRunner.runner };
      const record: WorkRecord = {
        intent: kind,
        settledPromise: settledControl.promise,
        startedPromise: startedControl.promise,
        runCount: 0,
        fencedCount: 0,
        settledCount: 0,
        errorCount: 0,
        effects: 0,
        staleAfterAwait: false,
        adopted: false,
      };
      records.push(record);
      seenIntents.add(kind);

      const admitted = m.schedule(
        intent,
        async (authority) => {
          record.runCount += 1;
          startedControl.resolve(undefined);
          let gate: ControlledGate;
          if (kind === "bootstrap") {
            const registered = m.getRunner();
            const runnerAtStart = runners.find((candidate) => candidate.runner === registered);
            if (runnerAtStart === undefined) return;
            record.adopted = authority.adoptCurrentRunner(runnerAtStart.runner);
            if (!record.adopted) return;
            gate = runnerAtStart.gate;
          } else if (kind === "binding") {
            gate = manualGate!;
          } else {
            gate = admissionRunner.gate;
          }
          await gate.promise;
          if (authority.isCurrent()) {
            record.effects += 1;
          } else {
            record.staleAfterAwait = true;
          }
        },
        async () => { record.errorCount += 1; },
        {
          onFenced: () => { record.fencedCount += 1; },
          onSettled: () => {
            record.settledCount += 1;
            settledControl.resolve(undefined);
          },
        },
      );
      if (!admitted) throw new Error(`trial ${seed}: admission unexpectedly closed`);
      return record;
    };

    const intentOrder: WorkIntent["kind"][] = [
      "current-runtime",
      "binding",
      "internal-runtime",
      "bootstrap",
    ];
    let nextIntent = 0;

    for (let i = 0; i < 36; i++) {
      const roll = rng();
      if (roll < 0.52) {
        admit(intentOrder[nextIntent % intentOrder.length]!);
        nextIntent += 1;
        await Promise.resolve();
      } else if (roll < 0.64) {
        m.cancelPending();
      } else if (roll < 0.76) {
        const replacement = createAndTrackRunner();
        m.registerInternalRuntime(replacement.runner);
        current = replacement;
        await Promise.resolve();
      } else if (roll < 0.86) {
        current.gate.release();
      } else if (roll < 0.92) {
        const gate = manualGates.find((candidate) => !candidate.isReleased());
        gate?.release();
      } else {
        const reason: InvalidationReason = rng() < 0.5 ? "settings-change" : "binding-change";
        await m.invalidate(reason);
        await m.awaitSettled();
        const replacement = createAndTrackRunner();
        m.registerInternalRuntime(replacement.runner);
        current = replacement;
      }
    }

    // Ensure every authority class participates even for an unusually sparse
    // random admission sequence.
    for (const kind of intentOrder) {
      if (!seenIntents.has(kind)) admit(kind);
    }

    // Settle the randomized phase, then inspect all callback and effect
    // invariants before constructing a dedicated outstanding shutdown race.
    for (const gate of manualGates) gate.release();
    for (const tracked of runners) tracked.gate.release();
    await settlesWithin(Promise.all(records.map((record) => record.settledPromise)).then(() => {}));

    const finalRunner = createAndTrackRunner();
    m.registerInternalRuntime(finalRunner.runner);
    current = finalRunner;
    const outstanding = admit("internal-runtime");
    await outstanding.startedPromise;

    // Shutdown begins while work is blocked. Disposing the current runner is
    // what releases that work; the bounded await proves shutdown owns both
    // the runner and queue lifetime rather than relying on pre-settled tests.
    await settlesWithin(m.shutdown());

    for (const record of records) {
      expect(record.runCount).toBeLessThanOrEqual(1);
      expect(record.fencedCount).toBeLessThanOrEqual(1);
      expect(record.settledCount).toBe(1);
      expect(record.errorCount).toBe(0);
      expect(record.effects).toBeLessThanOrEqual(1);
      if (record.staleAfterAwait) expect(record.effects).toBe(0);
      if (record.intent === "bootstrap" && !record.adopted) {
        expect(record.effects).toBe(0);
      }
    }
    for (const tracked of runners) {
      expect(tracked.disposeCalls).toBe(1);
    }
    expect(m.currentPhase).toBe("idle");
    expect(m.hasRunner()).toBe(false);
  }

  it("upholds held-authority invariants across 50 seeded asynchronous trials", async () => {
    for (let seed = 1; seed <= 50; seed++) {
      await runTrial(seed);
    }
  });
});
