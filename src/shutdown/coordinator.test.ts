import { describe, expect, it } from "bun:test";
import { ShutdownCoordinator, UpdateGate, SHUTDOWN_PHASE_NAMES } from "./mod.ts";

describe("ShutdownCoordinator", () => {
  it("owns the documented phase list as data", () => {
    // The causal ordering that previously lived as comments in index.ts is
    // now testable data (decision 0046).
    expect(SHUTDOWN_PHASE_NAMES).toEqual([
      "close-telegram-gate",
      "buffered-text-to-runtime-admission",
      "dispose-runtimes",
      "stop-telegram-polling",
      "drain-telegram-admission",
      "drain-scheduler",
      "dispose-external-agents",
      "dispose-subagents",
      "close-memory-engine",
    ]);
  });

  it("admission closes before runtime disposal is awaited", async () => {
    // The key invariant from decision 0046: disposal is not awaited before
    // admission closes. Reordering disposal ahead of admission close would
    // hang the fence on a handler blocked on a model operation that
    // disposal is supposed to release.
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const events: string[] = [];
    let admissionClosed = false;
    let disposalAwaited = false;

    // Wrap closeAdmission so we can observe when the gate's outer door
    // closes synchronously (the first thing the coordinator does).
    const realClose = gate.closeAdmission.bind(gate);
    gate.closeAdmission = (): Promise<void> => {
      admissionClosed = true;
      events.push("admission-closed");
      return realClose();
    };

    const coordinator = new ShutdownCoordinator({
      gate,
      stopTelegramPolling: async () => { events.push("stop-polling"); },
      drainBufferedText: () => gate.bufferedTextAdmission(),
      drainRuntimeAdmission: () => gate.runtimeAdmission(),
      disposeRuntimes: async () => {
        events.push("dispose-runtimes-started");
        // If disposal is awaited before admission closes, this would be
        // observed as admissionClosed === false at the point the coordinator
        // awaits disposal.
        if (!admissionClosed) disposalAwaited = true;
      },
      drainScheduler: async () => { events.push("drain-scheduler"); },
      disposeExternalAgents: async () => { events.push("dispose-external-agents"); },
      disposeSubagents: async () => { events.push("dispose-subagents"); },
      closeMemoryEngine: async () => { events.push("close-memory-engine"); },
    });

    const result = await coordinator.shutdown("SIGTERM");
    expect(result.ok).toBe(true);
    // The key invariant: admission closed before disposal was awaited.
    expect(disposalAwaited).toBe(false);
    // Admission close must precede disposal in the event log.
    const closeIdx = events.indexOf("admission-closed");
    const disposeIdx = events.indexOf("dispose-runtimes-started");
    expect(closeIdx).toBeLessThan(disposeIdx);
    // Subsystem disposal order: external agents → subagents → memory.
    const externalIdx = events.indexOf("dispose-external-agents");
    const subagentIdx = events.indexOf("dispose-subagents");
    const memoryIdx = events.indexOf("close-memory-engine");
    expect(externalIdx).toBeLessThan(subagentIdx);
    expect(subagentIdx).toBeLessThan(memoryIdx);
  });

  it("shutdown is idempotent and single-flight", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const coordinator = new ShutdownCoordinator({
      gate,
      stopTelegramPolling: async () => {},
      drainBufferedText: () => gate.bufferedTextAdmission(),
      drainRuntimeAdmission: () => gate.runtimeAdmission(),
      disposeRuntimes: async () => {},
      drainScheduler: async () => {},
      disposeExternalAgents: async () => {},
      disposeSubagents: async () => {},
      closeMemoryEngine: async () => {},
    });

    const first = coordinator.shutdown("SIGINT");
    expect(coordinator.shutdown("SIGTERM")).toBe(first);
    const result = await first;
    expect(result.ok).toBe(true);
  });

  it("reports failures without throwing", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const coordinator = new ShutdownCoordinator({
      gate,
      stopTelegramPolling: async () => { throw new Error("polling failed"); },
      drainBufferedText: () => gate.bufferedTextAdmission(),
      drainRuntimeAdmission: () => gate.runtimeAdmission(),
      disposeRuntimes: async () => { throw new Error("disposal failed"); },
      drainScheduler: async () => {},
      disposeExternalAgents: async () => {},
      disposeSubagents: async () => {},
      closeMemoryEngine: async () => {},
    });

    const result = await coordinator.shutdown("SIGTERM");
    expect(result.ok).toBe(false);
    expect(result.failures).toBe(2);
  });

  it("continues runtime disposal after buffered-text drain rejects", async () => {
    // A buffered-text drain rejection must not skip runtime disposal. The
    // buffered-text failure is reported as its own phase, and disposal still
    // runs — both failures are counted separately.
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    let disposeRuntimesCalled = false;
    const coordinator = new ShutdownCoordinator({
      gate,
      stopTelegramPolling: async () => {},
      drainBufferedText: async () => { throw new Error("buffered text failed"); },
      drainRuntimeAdmission: async () => {},
      disposeRuntimes: async () => {
        disposeRuntimesCalled = true;
        throw new Error("disposal failed");
      },
      drainScheduler: async () => {},
      disposeExternalAgents: async () => {},
      disposeSubagents: async () => {},
      closeMemoryEngine: async () => {},
    });

    const result = await coordinator.shutdown("SIGTERM");
    expect(disposeRuntimesCalled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failures).toBe(2);
  });
});

describe("UpdateGate", () => {
  it("admits work while open and drops after close completes", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    expect(gate.isOuterOpen()).toBe(true);
    expect(gate.admit("text")).toBe(true);

    // The outer door closes synchronously — the middleware rejects new
    // updates immediately.
    const close = gate.closeAdmission();
    expect(gate.isOuterOpen()).toBe(false);

    // The inner door (intake admission) stays open until the coalescer flush
    // completes, so buffered text can still enter intake. After the close
    // promise resolves, the inner door is closed too.
    await close;
    expect(gate.admit("text")).toBe(false);
  });

  it("closeAdmission is idempotent and single-flight", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const first = gate.closeAdmission();
    expect(gate.closeAdmission()).toBe(first);
    await first;
  });

  it("releases runtime admission exactly once via handle", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const ctx = {};
    const handle = gate.beginUpdate(ctx);

    // Observe the gate's internal in-flight runtime-admission set: it holds
    // the one promise from beginUpdate and is emptied by the first release.
    const inFlightRuntimeAdmissions = (gate as unknown as { inFlightRuntimeAdmissions: Set<Promise<void>> }).inFlightRuntimeAdmissions;
    expect(inFlightRuntimeAdmissions.size).toBe(1);

    // Multiple calls are idempotent: the set size drops to zero exactly once.
    handle.releaseRuntimeAdmission();
    handle.releaseRuntimeAdmission();
    handle.releaseRuntimeAdmission();
    expect(inFlightRuntimeAdmissions.size).toBe(0);

    // The public runtime-admission barrier must also be drained.
    await gate.runtimeAdmission();
  });

  it("settleUpdate releases barriers as a safety net", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const ctx = {};
    gate.beginUpdate(ctx);
    // Simulate a handler that crashes before releasing.
    const downstream = Promise.reject(new Error("handler crashed"));
    gate.settleUpdate(ctx, downstream);
    gate.trackAdmitted(downstream);

    // Both barriers should be released by the safety net.
    await gate.runtimeAdmission();
    const close = gate.closeAdmission();
    await close;
  });

  it("does not release runtime admission for coalesced updates on settle", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });

    const ctx = {};
    const handle = gate.beginUpdate(ctx);
    handle.markHandedToCoalescer();

    // Settle without releasing runtime admission — the coalescer owns that
    // release. The safety net should NOT release runtime admission for a
    // coalesced update.
    const downstream = Promise.resolve();
    gate.settleUpdate(ctx, downstream);

    // Let the settle callback run. It should release authorization but NOT
    // runtime admission (handedToCoalescer is true).
    await Promise.resolve();

    // Runtime admission should still be pending (the coalescer hasn't
    // released it yet).
    let drained = false;
    void gate.runtimeAdmission().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    // Now the coalescer releases.
    handle.releaseRuntimeAdmission();
    // Let the first runtimeAdmission() call's allSettled resolve and its
    // .then callback run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(true);
  });
});
