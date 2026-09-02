import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import {
  DelegatedWorkEpochCancelledError,
  DelegatedWorkHost,
  DelegatedWorkRuntimeInvalidatedError,
} from "./host.ts";
import { DelegatedWorkRecordError } from "./store.ts";
import { asConversationRuntimeId, type AttachedWorkAdapter } from "./types.ts";
import { delegatedWorkRecordPath, delegatedWorkRunDir } from "./paths.ts";
import {
  DEFAULT_CASCADE_TIMEOUT_MS,
  interruptAndCascade,
  type InterruptableSubagentRunner,
} from "../interrupt.ts";
import { cancelReply } from "../commands/cancel.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-delegated-host-"));
}

function ownership(runtimeId: string, ownerConversationId = "conversation-a", epochId = `epoch-${runtimeId}`) {
  return {
    lifetime: "attached" as const,
    ownerConversationId,
    runtimeId: asConversationRuntimeId(runtimeId),
    originSurfaceId: surfaceId(dmSurface(1)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: epochId,
  };
}

function durableOwnership(runtimeId: string, ownerConversationId = "conversation-durable", epochId = `epoch-${runtimeId}`) {
  return {
    lifetime: "durable" as const,
    ownerConversationId,
    runtimeId: asConversationRuntimeId(runtimeId),
    originSurfaceId: surfaceId(dmSurface(1)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: epochId,
  };
}

function adapter(overrides: Partial<AttachedWorkAdapter> = {}): AttachedWorkAdapter & {
  fenceCalls: number;
  cancelCalls: number;
  quiesceCalls: number;
} {
  const value = {
    fenceCalls: 0,
    cancelCalls: 0,
    quiesceCalls: 0,
    fence: () => { value.fenceCalls += 1; },
    cancel: async () => { value.cancelCalls += 1; },
    quiesce: async () => { value.quiesceCalls += 1; },
    ...overrides,
  };
  return value;
}

describe("DelegatedWorkHost", () => {
  it("fences before cancellation and proves attached work quiescent", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const registration = host.reserveAttached("run-1", ownership("runtime-1"));
    const work = adapter();
    registration.attach(work);

    const invalidation = host.invalidateRuntime(asConversationRuntimeId("runtime-1"));
    expect(registration.fenced).toBe(true);
    await invalidation;

    expect(work.fenceCalls).toBeGreaterThanOrEqual(1);
    expect(work.cancelCalls).toBe(1);
    expect(work.quiesceCalls).toBe(1);
    expect(host.registeredForRuntime(asConversationRuntimeId("runtime-1"))).toBe(0);
  });

  it("rejects a run reserved after runtime invalidation", async () => {
    const host = new DelegatedWorkHost(tempHome());
    await host.invalidateRuntime(asConversationRuntimeId("runtime-1"));

    expect(() => host.reserveAttached("run-2", ownership("runtime-1"))).toThrow(
      DelegatedWorkRuntimeInvalidatedError,
    );
  });

  it("fences a reservation that loses the attach race", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const registration = host.reserveAttached("run-3", ownership("runtime-3"));
    const invalidation = host.invalidateRuntime(asConversationRuntimeId("runtime-3"));
    const work = adapter();

    expect(() => registration.attach(work)).toThrow(DelegatedWorkRuntimeInvalidatedError);
    registration.release();
    await invalidation;
    expect(work.fenceCalls).toBe(1);
    expect(work.cancelCalls).toBe(0);
  });

  it("cancels an owner's epochs without invalidating the runtime", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const first = host.reserveAttached("run-owner-1", ownership("runtime-owner", "conversation-a", "epoch-owner"));
    const firstWork = adapter();
    first.attach(firstWork);
    const other = host.reserveAttached("run-other-1", ownership("runtime-other", "conversation-b", "epoch-other"));
    const otherWork = adapter();
    other.attach(otherWork);

    await host.cancelByConversation("conversation-a");

    expect(first.fenced).toBe(true);
    expect(firstWork.cancelCalls).toBe(1);
    expect(other.fenced).toBe(false);
    expect(otherWork.cancelCalls).toBe(0);
    expect(host.registeredForRuntime(asConversationRuntimeId("runtime-owner"))).toBe(0);
    other.release();
    expect(() => host.reserveAttached(
      "run-owner-2",
      ownership("runtime-owner", "conversation-a", "epoch-owner"),
    )).toThrow(DelegatedWorkEpochCancelledError);

    // A later root invocation gets a fresh epoch while the runtime remains
    // usable after an explicit /cancel.
    const later = host.reserveAttached(
      "run-owner-3",
      ownership("runtime-owner", "conversation-a", "epoch-later"),
    );
    later.release();
  });

  it("does not report quiescence when an adapter cannot prove it", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const registration = host.reserveAttached("run-4", ownership("runtime-4"));
    registration.attach(adapter({ quiesce: async () => { throw new Error("still active"); } }));

    await expect(host.invalidateRuntime(asConversationRuntimeId("runtime-4"))).rejects.toThrow(
      "still active",
    );
    expect(host.registeredForRuntime(asConversationRuntimeId("runtime-4"))).toBe(1);
  });

  it("settles runtime invalidation for an unattached, unreleased reservation", async () => {
    const host = new DelegatedWorkHost(tempHome());
    host.reserveAttached("run-unattached", ownership("runtime-unattached"));

    const invalidation = host.invalidateRuntime(asConversationRuntimeId("runtime-unattached"));
    await expect(invalidation).resolves.toBeUndefined();
  });

  it("marks non-terminal invocations interrupted at startup reconciliation", () => {
    const home = tempHome();
    const runId = "recon-aaaaaaaa-0000-0000-0000-000000000001";
    const dir = delegatedWorkRunDir(home, runId);
    mkdirSync(dir, { recursive: true });

    // Plant a record with a running invocation — the process died mid-run.
    const now = new Date().toISOString();
    writeFileSync(delegatedWorkRecordPath(home, runId), JSON.stringify({
      id: runId,
      kind: "generic-subagent",
      name: null,
      depth: 1,
      createdAt: now,
      invocations: [{
        index: 0,
        ownerConversationId: "conversation-a",
        runtimeId: "runtime-dead",
        ownershipEpochId: "epoch-dead",
        lifetime: "attached",
        originSurfaceId: surfaceId(dmSurface(1)),
        executionEnvironment: personalEnvironment(),
        status: "running",
        outcome: null,
        deliveryState: "pending",
        startedAt: now,
        completedAt: null,
      }],
    }));

    const host = new DelegatedWorkHost(home);

    const record = host.loadRecord(runId);
    expect(record).not.toBeNull();
    const invocation = record!.invocations[0]!;
    expect(invocation.status).toBe("interrupted");
    expect(invocation.outcome).toBeNull();
    expect(invocation.deliveryState).toBe("suppressed");
    expect(invocation.completedAt).not.toBeNull();
  });

  it("leaves terminal invocations untouched at startup reconciliation", () => {
    const home = tempHome();
    const runId = "recon-bbbbbbbb-0000-0000-0000-000000000002";
    const dir = delegatedWorkRunDir(home, runId);
    mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(delegatedWorkRecordPath(home, runId), JSON.stringify({
      id: runId,
      kind: "generic-subagent",
      name: null,
      depth: 1,
      createdAt: now,
      invocations: [{
        index: 0,
        ownerConversationId: "conversation-a",
        runtimeId: "runtime-done",
        ownershipEpochId: "epoch-done",
        lifetime: "attached",
        originSurfaceId: surfaceId(dmSurface(1)),
        executionEnvironment: personalEnvironment(),
        status: "completed",
        outcome: { kind: "success", text: "already done" },
        deliveryState: "delivered",
        startedAt: now,
        completedAt: now,
      }],
    }));

    const host = new DelegatedWorkHost(home);

    const record = host.loadRecord(runId);
    const invocation = record!.invocations[0]!;
    expect(invocation.status).toBe("completed");
    expect(invocation.deliveryState).toBe("delivered");
  });

  it("enforces delivery transitions at the host boundary", () => {
    const host = new DelegatedWorkHost(tempHome());

    host.createRecord(
      "delivery-pending",
      "generic-subagent",
      null,
      1,
      ownership("runtime-pending"),
    );
    expect(() => host.acknowledgeDelivery("delivery-pending", 0)).toThrow(
      "status is running",
    );

    host.completeInvocation("delivery-pending", 0, "done");
    host.suppressDelivery("delivery-pending", 0);
    expect(() => host.acknowledgeDelivery("delivery-pending", 0)).toThrow(
      "delivery is suppressed",
    );

    host.createRecord(
      "delivery-accepted",
      "generic-subagent",
      null,
      1,
      ownership("runtime-accepted"),
    );
    host.completeInvocation("delivery-accepted", 0, "done");
    host.acknowledgeDelivery("delivery-accepted", 0);
    expect(() => host.suppressDelivery("delivery-accepted", 0)).toThrow(
      "already delivered",
    );
  });

  it("continues startup reconciliation when one record is malformed", () => {
    const home = tempHome();
    const badRunId = "recon-bad-0000-0000-0000-000000000001";
    const goodRunId = "recon-good-0000-0000-0000-000000000002";

    const badDir = delegatedWorkRunDir(home, badRunId);
    const goodDir = delegatedWorkRunDir(home, goodRunId);
    mkdirSync(badDir, { recursive: true });
    mkdirSync(goodDir, { recursive: true });

    // Plant a malformed record that fails validation on load.
    writeFileSync(delegatedWorkRecordPath(home, badRunId), JSON.stringify({
      id: badRunId,
      kind: "generic-subagent",
    }));

    // Plant a valid record with a running invocation that should be closed.
    const now = new Date().toISOString();
    writeFileSync(delegatedWorkRecordPath(home, goodRunId), JSON.stringify({
      id: goodRunId,
      kind: "generic-subagent",
      name: null,
      depth: 1,
      createdAt: now,
      invocations: [{
        index: 0,
        ownerConversationId: "conversation-a",
        runtimeId: "runtime-dead",
        ownershipEpochId: "epoch-dead",
        lifetime: "attached",
        originSurfaceId: surfaceId(dmSurface(1)),
        executionEnvironment: personalEnvironment(),
        status: "running",
        outcome: null,
        deliveryState: "pending",
        startedAt: now,
        completedAt: null,
      }],
    }));

    const host = new DelegatedWorkHost(home);

    expect(() => host.loadRecord(badRunId)).toThrow(DelegatedWorkRecordError);

    const record = host.loadRecord(goodRunId);
    expect(record).not.toBeNull();
    const invocation = record!.invocations[0]!;
    expect(invocation.status).toBe("interrupted");
    expect(invocation.outcome).toBeNull();
    expect(invocation.deliveryState).toBe("suppressed");
    expect(invocation.completedAt).not.toBeNull();
  });

  it("does not fence, cancel, or quiesce durable registrations on runtime invalidation", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const registration = host.reserveDurable("durable-inval-1", durableOwnership("runtime-durable-inval"));
    const work = adapter();
    registration.attach(work);

    await host.invalidateRuntime(asConversationRuntimeId("runtime-durable-inval"));

    expect(work.fenceCalls).toBe(0);
    expect(work.cancelCalls).toBe(0);
    expect(work.quiesceCalls).toBe(0);
    expect(registration.fenced).toBe(false);
  });

  it("reserves durable registrations even after their captured runtime was invalidated", async () => {
    const host = new DelegatedWorkHost(tempHome());
    await host.invalidateRuntime(asConversationRuntimeId("runtime-gone"));

    const registration = host.reserveDurable("durable-inval-2", durableOwnership("runtime-gone"));
    registration.release();
  });

  it("captures the full decision-0036 ownership set on durable records", () => {
    const host = new DelegatedWorkHost(tempHome());
    const ownership = durableOwnership("runtime-durable-capture", "conversation-durable", "epoch-durable-capture");
    host.createRecord("durable-capture-1", "generic-subagent", null, 1, ownership);

    const record = host.loadRecord("durable-capture-1");
    expect(record).not.toBeNull();
    const invocation = record!.invocations[0]!;
    expect(invocation.lifetime).toBe("durable");
    expect(invocation.ownerConversationId).toBe("conversation-durable");
    expect(invocation.runtimeId).toBe("runtime-durable-capture");
    expect(invocation.ownershipEpochId).toBe("epoch-durable-capture");
    expect(invocation.originSurfaceId).toBe(ownership.originSurfaceId);
    expect(invocation.executionEnvironment).toEqual({ kind: "personal" });
    expect(invocation.status).toBe("running");
    expect(invocation.deliveryState).toBe("pending");
  });

  it("marks non-terminal durable invocations interrupted at startup reconciliation", () => {
    const home = tempHome();
    const runId = "recon-durable-0000-0000-0000-000000000003";
    const dir = delegatedWorkRunDir(home, runId);
    mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(delegatedWorkRecordPath(home, runId), JSON.stringify({
      id: runId,
      kind: "generic-subagent",
      name: null,
      depth: 1,
      createdAt: now,
      invocations: [{
        index: 0,
        ownerConversationId: "conversation-durable",
        runtimeId: "runtime-dead-durable",
        ownershipEpochId: "epoch-dead-durable",
        lifetime: "durable",
        originSurfaceId: surfaceId(dmSurface(1)),
        executionEnvironment: personalEnvironment(),
        status: "running",
        outcome: null,
        deliveryState: "pending",
        startedAt: now,
        completedAt: null,
      }],
    }));

    const host = new DelegatedWorkHost(home);

    const record = host.loadRecord(runId);
    const invocation = record!.invocations[0]!;
    expect(invocation.status).toBe("interrupted");
    expect(invocation.outcome).toBeNull();
    expect(invocation.deliveryState).toBe("suppressed");
    expect(invocation.completedAt).not.toBeNull();
  });

  it("closes a durable invocation completed with delivery pending", () => {
    const host = new DelegatedWorkHost(tempHome());
    host.createRecord(
      "durable-complete-1",
      "generic-subagent",
      null,
      1,
      durableOwnership("runtime-durable-complete"),
    );

    host.completeInvocation("durable-complete-1", 0, "durable result");

    const invocation = host.loadRecord("durable-complete-1")!.invocations[0]!;
    expect(invocation.status).toBe("completed");
    expect(invocation.outcome).toEqual({ kind: "success", text: "durable result" });
    expect(invocation.deliveryState).toBe("pending");
  });

  it("rejects durable ownership on attached reservations", () => {
    const host = new DelegatedWorkHost(tempHome());
    // The reservation boundary validates lifetime at runtime; the cast models
    // a caller that lies about its ownership type.
    const durable = durableOwnership("runtime-durable-reject") as unknown as Parameters<
      DelegatedWorkHost["reserveAttached"]
    >[1];
    expect(() => host.reserveAttached("durable-reject-1", durable)).toThrow(
      "only accepts attached",
    );
  });
});

describe("Owner cancellation of durable runs", () => {
  it("owner cancellation fences a durable run to terminal cancelled with delivery suppressed", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const ownership = durableOwnership(
      "runtime-durable-cancel",
      "conversation-durable",
      "epoch-durable-cancel",
    );
    const registration = host.reserveDurable("durable-cancel-1", ownership);
    host.createRecord("durable-cancel-1", "generic-subagent", null, 1, ownership);
    const before = host.loadRecord("durable-cancel-1")!.invocations[0]!;
    expect(before.status).toBe("running");
    expect(before.deliveryState).toBe("pending");
    const work = adapter();
    registration.attach(work);

    // The /cancel cascade owns routing: a running durable run explicitly owned
    // by the cancelling Conversation goes through the owner-scoped path, and
    // the cancellation itself is entirely host-owned.
    let individualCancelCalls = 0;
    const subagentRunner: InterruptableSubagentRunner = {
      list: () => [
        { id: "durable-cancel-1", status: "running", ownerConversationId: "conversation-durable" },
      ],
      cancel: async () => {
        individualCancelCalls += 1;
      },
      cancelByConversation: (conversationId: string) => host.cancelByConversation(conversationId),
    };

    const cascade = await interruptAndCascade(
      null,
      subagentRunner,
      DEFAULT_CASCADE_TIMEOUT_MS,
      "conversation-durable",
    );
    expect(cascade.attemptedSubagents).toBe(1);
    expect(cascade.timedOutSubagents).toBe(0);
    expect(individualCancelCalls).toBe(0);

    // Fence before cancel: the durable registration was fenced and its adapter
    // was destructively stopped and proven quiescent.
    expect(registration.fenced).toBe(true);
    expect(work.fenceCalls).toBe(1);
    expect(work.cancelCalls).toBe(1);
    expect(work.quiesceCalls).toBe(1);

    // Durable cancellation is destructive for the epoch: a late descendant
    // reservation cannot escape the owner's cancellation.
    expect(() =>
      host.reserveDurable(
        "durable-cancel-2",
        durableOwnership("runtime-durable-cancel", "conversation-durable", "epoch-durable-cancel"),
      ),
    ).toThrow(DelegatedWorkEpochCancelledError);

    // The execution coordinator closes the invocation through the host when
    // its cancellation cleanup runs (SubagentRunner.finishCancellationCleanup).
    const invocation = host.cancelInvocation("durable-cancel-1", 0).invocations[0]!;
    expect(invocation.status).toBe("cancelled");
    expect(invocation.outcome).toBeNull();
    expect(invocation.deliveryState).toBe("suppressed");
    const persisted = host.loadRecord("durable-cancel-1")!.invocations[0]!;
    expect(persisted.status).toBe("cancelled");
    expect(persisted.deliveryState).toBe("suppressed");

    // /cancel's honest-reply contract: the cascade attempted the durable run
    // and its cancellation resolved, so the reply is exactly "Cancelled." —
    // never "Nothing to cancel." and no invented timeout suffix.
    expect(cancelReply({ cascade, cascadeTimeoutMs: DEFAULT_CASCADE_TIMEOUT_MS })).toBe(
      "Cancelled.",
    );
  });

  it("cancellation from one conversation leaves other conversations' durable runs untouched", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const mine = durableOwnership("runtime-durable-mine", "conversation-durable-a", "epoch-durable-a");
    const theirs = durableOwnership(
      "runtime-durable-theirs",
      "conversation-durable-b",
      "epoch-durable-b",
    );

    const mineRegistration = host.reserveDurable("durable-scope-mine", mine);
    host.createRecord("durable-scope-mine", "generic-subagent", null, 1, mine);
    const mineWork = adapter();
    mineRegistration.attach(mineWork);

    const theirsRegistration = host.reserveDurable("durable-scope-theirs", theirs);
    host.createRecord("durable-scope-theirs", "generic-subagent", null, 1, theirs);
    const theirsWork = adapter();
    theirsRegistration.attach(theirsWork);

    await host.cancelByConversation("conversation-durable-a");

    // The cancelling owner's own durable run is fenced and destructively stopped.
    expect(mineRegistration.fenced).toBe(true);
    expect(mineWork.cancelCalls).toBe(1);
    expect(mineWork.quiesceCalls).toBe(1);

    // Another conversation's durable run is neither fenced, cancelled, nor
    // retargeted: its adapter is untouched and its record stays running with
    // delivery still pending.
    expect(theirsRegistration.fenced).toBe(false);
    expect(theirsWork.cancelCalls).toBe(0);
    expect(theirsWork.quiesceCalls).toBe(0);
    const theirsInvocation = host.loadRecord("durable-scope-theirs")!.invocations[0]!;
    expect(theirsInvocation.status).toBe("running");
    expect(theirsInvocation.deliveryState).toBe("pending");

    // Their epoch was not poisoned: it still accepts durable reservations and
    // a fresh registration still attaches.
    const lateTheirs = host.reserveDurable(
      "durable-scope-theirs-2",
      durableOwnership("runtime-durable-theirs", "conversation-durable-b", "epoch-durable-b"),
    );
    lateTheirs.attach(adapter());
    expect(lateTheirs.fenced).toBe(false);
    lateTheirs.release();
  });
});
