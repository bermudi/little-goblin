import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import {
  DelegatedWorkEpochCancelledError,
  DelegatedWorkHost,
  DelegatedWorkRuntimeInvalidatedError,
} from "./host.ts";
import { asConversationRuntimeId, type AttachedWorkAdapter } from "./types.ts";

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
});
