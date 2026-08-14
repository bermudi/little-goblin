import { describe, expect, it } from "bun:test";
import type { AgentRunner } from "../agent/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import {
  asConversationRuntimeId,
  DelegatedWorkHost,
  type ConversationRuntimeId,
} from "../delegated-work/mod.ts";
import { ConversationRuntimeHost } from "./conversation-runtime-host.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeRunner(dispose: () => Promise<void> = async () => {}): AgentRunner {
  return { dispose } as unknown as AgentRunner;
}

function fakeDelegatedWorkHost(): DelegatedWorkHost {
  return {
    invalidateRuntime: async (_runtimeId: ConversationRuntimeId): Promise<void> => {},
  } as unknown as DelegatedWorkHost;
}

function registerRunner(
  host: ConversationRuntimeHost,
  conversationId: ConversationId,
  runner: AgentRunner,
): void {
  host.registerSurfaceRuntime(conversationId, runner, {
    surfaceId: surfaceId(dmSurface(1)),
    runtimeId: asConversationRuntimeId(`runtime-${conversationId}`),
    skillContext: { settingsFingerprint: "test-settings", policyFingerprint: "test", manifestFingerprint: null },
  });
}

describe("ConversationRuntimeHost shutdown", () => {
  it("closes admission synchronously and waits for active runner disposal", async () => {
    const disposed = deferred<void>();
    let disposeCalls = 0;
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    registerRunner(
      host,
      "conversation-a",
      fakeRunner(async () => {
        disposeCalls += 1;
        await disposed.promise;
      }),
    );

    const shutdown = host.disposeAll();
    expect(host.isAdmissionOpen()).toBe(false);
    expect(host.hasRunner("conversation-a")).toBe(false);
    await Promise.resolve();
    expect(disposeCalls).toBe(1);
    expect(() => host.reserveCreation("conversation-b", surfaceId(dmSurface(1)), "test")).toThrow(
      /admission is closed/,
    );
    expect(() => host.registerInternalRuntime("conversation-c", fakeRunner())).toThrow(
      /admission is closed/,
    );
    expect(host.schedule("conversation-a", () => true, async () => {}, async () => {})).toBe(false);

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    disposed.resolve(undefined);
    await shutdown;
    expect(settled).toBe(true);
  });

  it("waits for a runtime construction reservation to finish", async () => {
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    const creation = host.reserveCreation("conversation-a", surfaceId(dmSurface(1)), "test");

    const shutdown = host.disposeAll();
    expect(host.isAdmissionOpen()).toBe(false);
    expect(host.hasRuntime("conversation-a")).toBe(false);

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    creation.complete();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("disposes a running turn before draining its queue", async () => {
    const turnFinished = deferred<void>();
    let disposeCalls = 0;
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    const runner = fakeRunner(async () => {
      disposeCalls += 1;
      turnFinished.resolve(undefined);
    });
    registerRunner(host, "conversation-a", runner);
    const order: string[] = [];

    expect(host.schedule(
      "conversation-a",
      () => host.isRegisteredRunner("conversation-a", runner),
      async () => {
        order.push("first");
        await turnFinished.promise;
      },
      async () => {},
    )).toBe(true);
    expect(host.schedule(
      "conversation-a",
      () => host.isRegisteredRunner("conversation-a", runner),
      async () => { order.push("second"); },
      async () => {},
    )).toBe(true);

    await host.disposeAll();

    expect(disposeCalls).toBe(1);
    expect(order).toEqual(["first"]);
    expect(host.hasRunner("conversation-a")).toBe(false);
  });

  it("does not start an admitted queued command after shutdown begins", async () => {
    const turnFinished = deferred<void>();
    const order: string[] = [];
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    const runner = fakeRunner(async () => {
      turnFinished.resolve(undefined);
    });
    registerRunner(host, "conversation-a", runner);

    expect(host.schedule(
      "conversation-a",
      () => true,
      async () => {
        order.push("prompt");
        await turnFinished.promise;
      },
      async () => {},
    )).toBe(true);
    expect(host.schedule(
      "conversation-a",
      () => true,
      async () => {
        order.push("command");
      },
      async () => {},
      { isPrompt: false },
    )).toBe(true);

    await host.disposeAll();

    expect(order).toEqual(["prompt"]);
  });

  it("rejects runtime registration after admission closes", () => {
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    host.closeAdmission();

    expect(() => host.registerSurfaceRuntime(
      "conversation-a",
      fakeRunner(),
      {
        surfaceId: surfaceId(dmSurface(1)),
        runtimeId: asConversationRuntimeId("runtime-a"),
        skillContext: { settingsFingerprint: "test-settings", policyFingerprint: "test", manifestFingerprint: null },
      },
    )).toThrow(/admission is closed/);
  });

  it("fences a replacement invalidated while prior-generation disposal is still draining", async () => {
    const oldRunnerDisposed = deferred<void>();
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    registerRunner(host, "conversation-a", fakeRunner(() => oldRunnerDisposed.promise));

    // a: Fence the old generation, but hold its physical cleanup open.
    const oldDisposal = host.disposeRuntime("conversation-a");

    // b: A replacement reserves a newer generation and waits at the same
    // settlement gate used by TurnDispatcher before registration.
    const replacement = host.reserveCreation(
      "conversation-a",
      surfaceId(dmSurface(1)),
      "replacement-policy",
    );
    const replacementRunner = fakeRunner();
    let replacementRegistered = false;
    const replacementAttempt = (async (): Promise<void> => {
      await host.awaitSettled("conversation-a");
      if (!host.isCurrentCreation("conversation-a", replacement.promise)) return;
      host.registerSurfaceRuntime("conversation-a", replacementRunner, {
        surfaceId: surfaceId(dmSurface(1)),
        runtimeId: asConversationRuntimeId("runtime-replacement"),
        skillContext: { settingsFingerprint: "test-settings", policyFingerprint: "replacement-policy", manifestFingerprint: null },
      });
      replacementRegistered = true;
    })();
    await Promise.resolve();

    // c: A second invalidation targets the replacement generation while the
    // old generation is still disposing.
    await host.disposeRuntime("conversation-a");
    expect(host.isCurrentCreation("conversation-a", replacement.promise)).toBe(false);

    // d: Releasing old cleanup must not let the invalidated replacement escape
    // its creation fence and register afterward.
    oldRunnerDisposed.resolve(undefined);
    await oldDisposal;
    await replacementAttempt;

    expect(replacementRegistered).toBe(false);
    expect(host.hasRunner("conversation-a")).toBe(false);
    replacement.complete();
  });

  it("retries delegated invalidation after a failed disposal", async () => {
    let attempts = 0;
    const delegatedWorkHost = {
      invalidateRuntime: async (): Promise<void> => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary delegated failure");
      },
    } as unknown as DelegatedWorkHost;
    const host = new ConversationRuntimeHost({ delegatedWorkHost });
    registerRunner(host, "conversation-a", fakeRunner());

    await expect(host.disposeRuntime("conversation-a")).rejects.toThrow("temporary delegated failure");
    await host.disposeRuntime("conversation-a");
    expect(attempts).toBe(2);
  });

  it("applies a later stronger fence before deduplicating cleanup", async () => {
    const disposed = deferred<void>();
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    registerRunner(host, "conversation-a", fakeRunner(() => disposed.promise));
    const creation = host.reserveCreation("conversation-a", surfaceId(dmSurface(1)), "test");

    const first = host.disposeRuntime("conversation-a", { preserveInFlight: creation.promise });
    expect(host.isCurrentCreation("conversation-a", creation.promise)).toBe(true);
    expect(host.disposeRuntime("conversation-a")).toBe(first);
    expect(host.isCurrentCreation("conversation-a", creation.promise)).toBe(false);

    disposed.resolve(undefined);
    await first;
    creation.complete();
  });

  it("retains a fast eager-disposal failure while another runtime queue drains", async () => {
    const queued = deferred<void>();
    const cleanupFailure = new Error("fast cleanup failed");
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    const queuedRunner = fakeRunner();
    registerRunner(host, "conversation-fast", fakeRunner(async () => { throw cleanupFailure; }));
    registerRunner(host, "conversation-queued", queuedRunner);
    expect(host.schedule(
      "conversation-queued",
      () => host.isRegisteredRunner("conversation-queued", queuedRunner),
      () => queued.promise,
      async () => {},
    )).toBe(true);

    const shutdown = host.disposeAll();
    // Let the eager disposal reject and leave the live active-disposal index
    // while shutdown remains blocked on the unrelated accepted queue.
    await Promise.resolve();
    await Promise.resolve();
    queued.resolve(undefined);

    await expect(shutdown).rejects.toBe(cleanupFailure);
  });

  it("makes shutdown and overlapping runtime disposal single-flight", async () => {
    const disposed = deferred<void>();
    const host = new ConversationRuntimeHost({ delegatedWorkHost: fakeDelegatedWorkHost() });
    registerRunner(host, "conversation-a", fakeRunner(() => disposed.promise));

    const activeDisposal = host.disposeRuntime("conversation-a");
    const shutdown = host.disposeAll();

    expect(host.disposeRuntime("conversation-a")).toBe(activeDisposal);
    expect(host.disposeAll()).toBe(shutdown);

    disposed.resolve(undefined);
    await activeDisposal;
    await shutdown;
  });
});
