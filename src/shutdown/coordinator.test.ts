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

  it("starts runtime disposal before awaiting runtime admission or stopping polling", async () => {
    const gate = new UpdateGate({
      closeCoalescer: async () => {},
      awaitBufferedTextAdmission: async () => {},
    });
    let releaseAdmission!: () => void;
    const admissionDrain = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const events: string[] = [];
    const coordinator = new ShutdownCoordinator({
      gate,
      stopTelegramPolling: async () => { events.push("stop"); },
      drainBufferedText: async () => { events.push("buffered"); },
      drainRuntimeAdmission: () => {
        events.push("runtime-admission");
        return admissionDrain;
      },
      disposeRuntimes: async () => { events.push("dispose"); },
      drainScheduler: async () => {},
      disposeExternalAgents: async () => {},
      disposeSubagents: async () => {},
      closeMemoryEngine: async () => {},
    });

    const shutdown = coordinator.shutdown("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["buffered", "dispose", "runtime-admission", "stop"]);
    releaseAdmission();
    expect((await shutdown).ok).toBe(true);
  });
});
