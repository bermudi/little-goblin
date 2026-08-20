import { describe, expect, it } from "bun:test";
import {
  ShutdownCoordinator,
  UpdateGate,
  SHUTDOWN_PHASE_NAMES,
  completed,
  type UpdateClaim,
} from "./mod.ts";

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

describe("UpdateGate", () => {
  const makeGate = () => new UpdateGate({
    closeCoalescer: async () => {},
    awaitBufferedTextAdmission: async () => {},
  });

  it("records a structural decision before awaiting completion", async () => {
    const gate = makeGate();
    let finish!: () => void;
    let claim!: UpdateClaim<void>;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const decision = { kind: "handoff" as const, completion };
    const boundary = gate.runUpdate<void>((ownedClaim) => {
      claim = ownedClaim;
      return decision;
    });

    await gate.runtimeAdmission();
    const state = (gate as unknown as {
      claims: WeakMap<object, { terminal?: { kind: string; decision?: unknown } }>;
    }).claims.get(claim as object);
    expect(state?.terminal).toEqual({ kind: "decision", decision });
    let completed = false;
    void boundary.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    finish();
    await boundary;
  });

  it("owns closed and does not execute a boundary after close", async () => {
    const gate = makeGate();
    await gate.closeAdmission();
    const ctx = {};
    await gate.runAuthorization(ctx, async () => {});
    const authorization = (gate as unknown as {
      authorizations: WeakMap<object, { outcome: { kind: string } }>;
    }).authorizations.get(ctx);
    expect(authorization?.outcome).toEqual({ kind: "closed" });

    let called = false;
    await expect(gate.runUpdate(() => {
      called = true;
      return { kind: "completed", completion: Promise.resolve() };
    })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("records failed-before-decision, releases safety nets, and propagates", async () => {
    const gate = makeGate();
    const failure = new Error("handler crashed");
    let claim!: UpdateClaim<void>;
    await expect(gate.runUpdate<void>((ownedClaim) => {
      claim = ownedClaim;
      throw failure;
    })).rejects.toBe(failure);
    const state = (gate as unknown as {
      claims: WeakMap<object, { terminal?: { kind: string; error?: unknown } }>;
    }).claims.get(claim as object);
    expect(state?.terminal).toEqual({ kind: "failed-before-decision", error: failure });
    await gate.runtimeAdmission();
    await gate.closeAdmission();
  });

  it("fails loud when a boundary returns no decision", async () => {
    const gate = makeGate();
    await expect(gate.runUpdate(() => undefined as never)).rejects.toThrow(
      "without an admission decision",
    );
    await gate.runtimeAdmission();
  });

  it("does not rewrite a decision when completion fails", async () => {
    const gate = makeGate();
    const failure = new Error("delivery failed");
    const boundary = gate.runUpdate(() => ({
      kind: "handoff",
      completion: Promise.reject(failure),
    }));
    await gate.runtimeAdmission();
    await expect(boundary).rejects.toBe(failure);
  });

  it("keeps a transferred coalescer claim pending and rejects contradictory settlement", async () => {
    const gate = makeGate();
    let claim!: UpdateClaim<void>;
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const boundary = gate.runUpdate<void>((ownedClaim) => {
      claim = ownedClaim;
      return gate.transferUpdate(ownedClaim);
    });
    await Promise.resolve();

    let drained = false;
    void gate.runtimeAdmission().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    const decision = { kind: "handoff" as const, completion };
    gate.settleTransferred([claim], decision);
    gate.settleTransferred([claim], decision); // repeated internal finalization is idempotent
    await gate.runtimeAdmission();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(true);
    let completed = false;
    void boundary.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(() => gate.settleTransferred([claim], {
      kind: "rejected",
      completion: Promise.resolve(),
    })).toThrow("contradictory decisions");
    finish();
    await boundary;
  });

  it("records denied authorization as completed and consumes one authorized transfer", async () => {
    const gate = makeGate();
    const deniedCtx = {};
    await gate.runAuthorization(deniedCtx, async () => {});
    const authorizations = (gate as unknown as {
      authorizations: WeakMap<object, {
        outcome: { kind: string; decision?: { kind: string }; error?: unknown };
      }>;
    }).authorizations;
    expect(authorizations.get(deniedCtx)?.outcome).toEqual({
      kind: "completed",
      decision: expect.objectContaining({ kind: "completed" }),
    });

    const allowedCtx = {};
    await gate.runAuthorization(allowedCtx, async () => {
      gate.commitAuthorization(allowedCtx);
      await gate.runUpdate(allowedCtx, () => completed(undefined));
    });
    expect(authorizations.get(allowedCtx)?.outcome).toEqual({ kind: "admitted" });
    expect(() => gate.runUpdate(allowedCtx, () => completed(undefined))).toThrow(
      "cannot enter admission after admitted",
    );

    const failedCtx = {};
    const failure = new Error("authorization failed");
    await expect(gate.runAuthorization(failedCtx, async () => { throw failure; })).rejects.toBe(failure);
    expect(authorizations.get(failedCtx)?.outcome).toEqual({
      kind: "failed-before-decision",
      error: failure,
    });
  });

  it("fails loud when authorization commits without an admission boundary", async () => {
    const gate = makeGate();
    const ctx = {};
    await expect(gate.runAuthorization(ctx, async () => {
      gate.commitAuthorization(ctx);
    })).rejects.toThrow("completed without an admission boundary");
    await gate.runtimeAdmission();
  });

  it("closeAdmission is idempotent and single-flight", async () => {
    const gate = makeGate();
    const first = gate.closeAdmission();
    expect(gate.closeAdmission()).toBe(first);
    await first;
  });

  it("awaits a rejected admission's completion so delivery settles before the drain", async () => {
    // A rejected admission is a terminal structural decision, but its
    // completion may still carry required one-shot delivery (e.g. /revive's
    // failure reply). The gate releases the runtime-admission drain at the
    // decision and separately awaits the completion as part of the boundary,
    // so shutdown cannot exit before delivery settles (decision 0046).
    const gate = makeGate();
    let deliver!: () => void;
    let delivered = false;
    const completion = new Promise<void>((resolve) => {
      deliver = () => { delivered = true; resolve(); };
    });
    const boundary = gate.runUpdate(() => ({
      kind: "rejected" as const,
      completion,
    }));

    // The runtime-admission drain is released by the decision: it completes
    // before delivery settles, so runtime disposal is not blocked.
    await gate.runtimeAdmission();
    expect(delivered).toBe(false);

    // The boundary (and thus the gate drain) waits for delivery.
    let boundarySettled = false;
    void boundary.then(() => { boundarySettled = true; });
    await Promise.resolve();
    expect(boundarySettled).toBe(false);

    deliver();
    await boundary;
    expect(delivered).toBe(true);
    await gate.closeAdmission();
  });

  it("propagates a rejected admission's completion failure through the boundary", async () => {
    // A rejected completion that fails (e.g. delivery threw) must surface to
    // the caller via the boundary, not be silently swallowed. Previously the
    // gate detached the rejected completion with an empty catch, so the
    // boundary resolved with undefined and the failure disappeared. The
    // structural decision remains `rejected`; only the completion failure
    // propagates. The drain awaits the boundary via allSettled, so it does
    // not re-throw — the caller observes the failure, matching the
    // non-rejected completion-failure contract.
    const gate = makeGate();
    const failure = new Error("rejected delivery failed");
    const boundary = gate.runUpdate(() => ({
      kind: "rejected" as const,
      completion: Promise.reject(failure),
    }));
    await gate.runtimeAdmission();
    await expect(boundary).rejects.toBe(failure);
    // The drain no longer hangs on the rejected completion: it awaited the
    // boundary and completes once it settles.
    await gate.closeAdmission();
  });

  it("awaits a rejected transferred decision's completion so delivery settles", async () => {
    const gate = makeGate();
    let claim!: UpdateClaim<void>;
    let deliver!: () => void;
    let delivered = false;
    const completion = new Promise<void>((resolve) => {
      deliver = () => { delivered = true; resolve(); };
    });
    const boundary = gate.runUpdate<void>((ownedClaim) => {
      claim = ownedClaim;
      return gate.transferUpdate(ownedClaim);
    });
    await Promise.resolve();
    gate.settleTransferred([claim], { kind: "rejected", completion });

    // Runtime-admission drain releases at the decision, before delivery.
    await gate.runtimeAdmission();
    expect(delivered).toBe(false);

    let boundarySettled = false;
    void boundary.then(() => { boundarySettled = true; });
    await Promise.resolve();
    expect(boundarySettled).toBe(false);

    deliver();
    await boundary;
    expect(delivered).toBe(true);
    await gate.closeAdmission();
  });

  it("propagates a rejected transferred decision's completion failure", async () => {
    const gate = makeGate();
    let claim!: UpdateClaim<void>;
    const failure = new Error("rejected transferred delivery failed");
    const boundary = gate.runUpdate<void>((ownedClaim) => {
      claim = ownedClaim;
      return gate.transferUpdate(ownedClaim);
    });
    await Promise.resolve();
    gate.settleTransferred([claim], { kind: "rejected", completion: Promise.reject(failure) });
    await gate.runtimeAdmission();
    await expect(boundary).rejects.toBe(failure);
    await gate.closeAdmission();
  });
});
