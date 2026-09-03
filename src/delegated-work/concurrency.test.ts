import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId, type Surface, type SurfaceId } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import { PendingCompletionClaim } from "./claim.ts";
import {
  DurableCompletionWake,
  type CompletionWakeRail,
  type WakeTurnAdmission,
} from "./delivery.ts";
import { DelegatedWorkHost } from "./host.ts";
import { DelegatedWorkRecordStore } from "./store.ts";
import { asConversationRuntimeId, type DurableDelegatedWorkOwnership } from "./types.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-delegated-concurrency-"));
}

function durableOwnership(originSurfaceId: SurfaceId): DurableDelegatedWorkOwnership {
  return {
    lifetime: "durable",
    ownerConversationId: "conversation-concurrency",
    runtimeId: asConversationRuntimeId("runtime-concurrency"),
    originSurfaceId,
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-concurrency",
  };
}

function boundConversation(id: string): ConversationState {
  return { id, createdAt: new Date().toISOString(), executionEnvironment: personalEnvironment() };
}

class FakeRail implements CompletionWakeRail {
  readonly bindings = new Map<string, ConversationState>();
  readonly enqueued: Array<{ readonly surface: Surface; readonly content: string }> = [];

  async resolveCurrent(surface: Surface): Promise<ConversationState | null> {
    return this.bindings.get(surfaceId(surface)) ?? null;
  }

  enqueueScheduledTurn(
    _conversation: ConversationState,
    surface: Surface,
    content: string,
  ): boolean | WakeTurnAdmission {
    this.enqueued.push({ surface, content });
    return {
      accepted: true,
      started: Promise.resolve(true),
      settled: Promise.resolve(true),
    };
  }
}

function timestamp(second: number): string {
  return `2026-09-03T10:00:${String(second).padStart(2, "0")}.000Z`;
}

describe("Concurrent durable completion delivery", () => {
  it("a racing wake and interaction claim enqueue exactly one turn for the same completion", async () => {
    const home = tempHome();
    const origin = surfaceId(dmSurface(301));
    const host = new DelegatedWorkHost(home);
    host.createRecord("concurrent-wake", "generic-subagent", null, 1, durableOwnership(origin));
    host.completeInvocation("concurrent-wake", 0, "wake result");

    const rail = new FakeRail();
    rail.bindings.set(origin, boundConversation("conversation-concurrency"));
    const wake = new DurableCompletionWake(rail, host);
    const claim = new PendingCompletionClaim(wake, host);

    await Promise.all([
      wake.deliverCompletion("concurrent-wake", 0),
      claim.claimForInteraction(dmSurface(301)),
    ]);

    expect(rail.enqueued).toHaveLength(1);
    expect(rail.enqueued[0]!.content).toContain("wake result");
    expect(host.loadRecord("concurrent-wake")!.invocations[0]!.deliveryState).toBe("delivered");
  });

  it("two concurrent authorized interactions deliver each retained completion once", async () => {
    const home = tempHome();
    const origin = surfaceId(dmSurface(302));
    const host = new DelegatedWorkHost(home);
    const store = new DelegatedWorkRecordStore(home);
    for (let index = 0; index < 3; index++) {
      const runId = `concurrent-claim-${index}`;
      store.createRecord(runId, "generic-subagent", null, 1, durableOwnership(origin), timestamp(index));
      store.closeInvocation(
        runId,
        0,
        "completed",
        { kind: "success", text: `claim result ${index}` },
        "pending",
        timestamp(10 + index),
      );
    }

    const rail = new FakeRail();
    rail.bindings.set(origin, boundConversation("conversation-concurrency"));
    const claim = new PendingCompletionClaim(new DurableCompletionWake(rail, host), host);

    await Promise.all([
      claim.claimForInteraction(dmSurface(302)),
      claim.claimForInteraction(dmSurface(302)),
    ]);

    expect(rail.enqueued).toHaveLength(3);
    expect(rail.enqueued.map((turn) => turn.content)).toEqual([
      expect.stringContaining("claim result 0"),
      expect.stringContaining("claim result 1"),
      expect.stringContaining("claim result 2"),
    ]);
    for (let index = 0; index < 3; index++) {
      expect(host.loadRecord(`concurrent-claim-${index}`)!.invocations[0]!.deliveryState).toBe(
        "delivered",
      );
    }
  });
});
