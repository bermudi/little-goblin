import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dmSurface, surfaceId, topicSurface, type Surface, type SurfaceId } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import { DelegatedWorkHost } from "./host.ts";
import {
  DELEGATED_COMPLETION_PROMPT_PREFIX,
  DurableCompletionWake,
  type CompletionWakeRail,
  type WakeTurnAdmission,
} from "./delivery.ts";
import { asConversationRuntimeId, type DurableDelegatedWorkOwnership } from "./types.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-delegated-delivery-"));
}

function durableOwnership(originSurfaceId: SurfaceId): DurableDelegatedWorkOwnership {
  return {
    lifetime: "durable",
    ownerConversationId: "conversation-durable",
    runtimeId: asConversationRuntimeId("runtime-durable"),
    originSurfaceId,
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-durable",
  };
}

function boundConversation(id: string): ConversationState {
  return { id, createdAt: new Date().toISOString(), executionEnvironment: personalEnvironment() };
}

interface EnqueuedTurn {
  readonly conversation: ConversationState;
  readonly surface: Surface;
  readonly content: string;
}

/** Test double for the surface-bound system-turn rail (scheduled turns). */
class FakeRail implements CompletionWakeRail {
  readonly bindings = new Map<string, ConversationState>();
  readonly enqueued: EnqueuedTurn[] = [];
  private heldStarted: Promise<boolean> | null = null;

  holdNextStarted(started: Promise<boolean>): void {
    this.heldStarted = started;
  }

  async resolveCurrent(surface: Surface): Promise<ConversationState | null> {
    return this.bindings.get(surfaceId(surface)) ?? null;
  }

  enqueueScheduledTurn(
    conversation: ConversationState,
    surface: Surface,
    content: string,
  ): boolean | WakeTurnAdmission {
    this.enqueued.push({ conversation, surface, content });
    const started = this.heldStarted;
    this.heldStarted = null;
    return { accepted: true, started: started ?? Promise.resolve(true) };
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Completion wake delivery", () => {
  it("completion wakes the currently bound origin Surface as a system-owned turn and marks the invocation delivered", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const origin = surfaceId(dmSurface(111));
    // A second Surface bound to the same Conversation must not receive the
    // result because it shares the Conversation, environment, or CWD.
    const sameConversationSurface = surfaceId(topicSurface("supergroup", -100123, 7));
    host.createRecord("wake-run-1", "generic-subagent", null, 1, durableOwnership(origin));
    host.completeInvocation("wake-run-1", 0, "the finished subagent result");

    const rail = new FakeRail();
    rail.bindings.set(origin, boundConversation("conversation-durable"));
    rail.bindings.set(sameConversationSurface, boundConversation("conversation-durable"));

    // Hold the rail's start handle open so `delivered` can only be recorded
    // after the send is accepted.
    let resolveStarted!: (started: boolean) => void;
    const started = new Promise<boolean>((resolve) => {
      resolveStarted = resolve;
    });
    rail.holdNextStarted(started);

    const wake = new DurableCompletionWake(rail, host);
    const outcome = wake.deliverCompletion("wake-run-1", 0);
    outcome.catch(() => {});
    await flush();

    expect(rail.enqueued.length).toBe(1);
    expect(surfaceId(rail.enqueued[0]!.surface)).toBe(origin);
    expect(rail.enqueued[0]!.conversation.id).toBe("conversation-durable");
    expect(rail.enqueued[0]!.content).toContain(DELEGATED_COMPLETION_PROMPT_PREFIX);
    expect(rail.enqueued[0]!.content).toContain("the finished subagent result");
    expect(host.loadRecord("wake-run-1")!.invocations[0]!.deliveryState).toBe("pending");

    resolveStarted(true);
    expect(await outcome).toBe("delivered");
    expect(host.loadRecord("wake-run-1")!.invocations[0]!.deliveryState).toBe("delivered");
  });

  it("keeps the completion pending when the rail fences the turn before it starts", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const origin = surfaceId(dmSurface(112));
    host.createRecord("wake-run-2", "generic-subagent", null, 1, durableOwnership(origin));
    host.completeInvocation("wake-run-2", 0, "result delivered to nobody");

    const rail = new FakeRail();
    rail.bindings.set(origin, boundConversation("conversation-durable"));
    rail.holdNextStarted(Promise.resolve(false));

    const wake = new DurableCompletionWake(rail, host);
    expect(await wake.deliverCompletion("wake-run-2", 0)).toBe("pending");
    expect(rail.enqueued.length).toBe(1);
    expect(host.loadRecord("wake-run-2")!.invocations[0]!.deliveryState).toBe("pending");
  });

  it("an unbound origin Surface keeps the completion pending with nothing sent", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const origin = surfaceId(dmSurface(113));
    host.createRecord("wake-run-3", "generic-subagent", null, 1, durableOwnership(origin));
    host.completeInvocation("wake-run-3", 0, "result nobody is waiting for");

    const rail = new FakeRail();
    const wake = new DurableCompletionWake(rail, host);
    expect(await wake.deliverCompletion("wake-run-3", 0)).toBe("pending");
    expect(rail.enqueued.length).toBe(0);
    expect(host.loadRecord("wake-run-3")!.invocations[0]!.deliveryState).toBe("pending");
  });

  it("never auto-delivers a failed execution that stays suppressed", async () => {
    const host = new DelegatedWorkHost(tempHome());
    const origin = surfaceId(dmSurface(114));
    host.createRecord("wake-run-4", "generic-subagent", null, 1, durableOwnership(origin));
    host.failInvocation("wake-run-4", 0, "the subagent exploded");

    const rail = new FakeRail();
    rail.bindings.set(origin, boundConversation("conversation-durable"));

    const wake = new DurableCompletionWake(rail, host);
    expect(await wake.deliverCompletion("wake-run-4", 0)).toBe("suppressed");
    expect(rail.enqueued.length).toBe(0);
    expect(host.loadRecord("wake-run-4")!.invocations[0]!.deliveryState).toBe("suppressed");
  });
});
