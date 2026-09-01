import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dmSurface,
  guestSurface,
  surfaceId,
  type Surface,
  type SurfaceId,
} from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import { DelegatedWorkHost } from "./host.ts";
import {
  DurableCompletionWake,
  type CompletionWakeRail,
  type WakeTurnAdmission,
} from "./delivery.ts";
import { PENDING_COMPLETIONS_PER_CLAIM_CAP, PendingCompletionClaim } from "./claim.ts";
import { DelegatedWorkRecordStore } from "./store.ts";
import { asConversationRuntimeId, type DurableDelegatedWorkOwnership } from "./types.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-delegated-claim-"));
}

function durableOwnership(originSurfaceId: SurfaceId): DurableDelegatedWorkOwnership {
  return {
    lifetime: "durable",
    ownerConversationId: "conversation-claim",
    runtimeId: asConversationRuntimeId("runtime-claim"),
    originSurfaceId,
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-claim",
  };
}

function boundConversation(id: string): ConversationState {
  return { id, createdAt: new Date().toISOString(), executionEnvironment: personalEnvironment() };
}

function timestamp(second: number): string {
  return `2026-08-31T10:00:${String(second).padStart(2, "0")}.000Z`;
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

describe("Pending claim and startup re-arm", () => {
  it("pending completions survive process restart retained for their exact origin Surface", async () => {
    const home = tempHome();
    const originA = surfaceId(dmSurface(211));
    const originB = surfaceId(dmSurface(212));
    const bystander = surfaceId(dmSurface(213));

    // Before the restart: one completion left pending because its origin
    // Surface was unbound, one because the rail fenced the send before start.
    const railBefore = new FakeRail();
    const before = new DelegatedWorkHost(home);
    const wakeBefore = new DurableCompletionWake(railBefore, before);
    before.createRecord("claim-restart-a", "generic-subagent", null, 1, durableOwnership(originA));
    before.completeInvocation("claim-restart-a", 0, "result unbound at completion");
    expect(await wakeBefore.deliverCompletion("claim-restart-a", 0)).toBe("pending");

    railBefore.bindings.set(originB, boundConversation("conversation-claim"));
    railBefore.holdNextStarted(Promise.resolve(false));
    before.createRecord("claim-restart-b", "generic-subagent", null, 1, durableOwnership(originB));
    before.completeInvocation("claim-restart-b", 0, "result fenced before start");
    expect(await wakeBefore.deliverCompletion("claim-restart-b", 0)).toBe("pending");

    // Process restart: a fresh host over the same home retains both.
    const rail = new FakeRail();
    const after = new DelegatedWorkHost(home);
    const claim = new PendingCompletionClaim(new DurableCompletionWake(rail, after), after);
    expect(claim.listPendingForSurface(originA).map((ref) => ref.runId)).toEqual([
      "claim-restart-a",
    ]);
    expect(claim.listPendingForSurface(originB).map((ref) => ref.runId)).toEqual([
      "claim-restart-b",
    ]);

    // Exactness: a different Surface sharing the same Conversation claims
    // nothing, and each exact origin Surface claims only its own completion.
    rail.bindings.set(originB, boundConversation("conversation-claim"));
    rail.bindings.set(bystander, boundConversation("conversation-claim"));
    expect(await claim.claimForInteraction(dmSurface(213))).toBe(0);
    expect(rail.enqueued.length).toBe(0);
    expect(await claim.claimForInteraction(dmSurface(212))).toBe(1);
    expect(surfaceId(rail.enqueued[0]!.surface)).toBe(originB);
    expect(after.loadRecord("claim-restart-b")!.invocations[0]!.deliveryState).toBe("delivered");
    expect(after.loadRecord("claim-restart-a")!.invocations[0]!.deliveryState).toBe("pending");
    expect(await claim.claimForInteraction(dmSurface(211))).toBe(1);
    expect(surfaceId(rail.enqueued[1]!.surface)).toBe(originA);
    expect(after.loadRecord("claim-restart-a")!.invocations[0]!.deliveryState).toBe("delivered");
  });

  it("an authorized interaction claims retained completions oldest-first under the per-claim cap and marks them delivered", async () => {
    const home = tempHome();
    const origin = surfaceId(dmSurface(221));
    const host = new DelegatedWorkHost(home);
    const store = new DelegatedWorkRecordStore(home);
    const total = PENDING_COMPLETIONS_PER_CLAIM_CAP + 2;
    for (let i = 0; i < total; i++) {
      const runId = `claim-cap-${i}`;
      store.createRecord(runId, "generic-subagent", null, 1, durableOwnership(origin), timestamp(i));
      store.closeInvocation(
        runId,
        0,
        "completed",
        { kind: "success", text: `result ${i}` },
        "pending",
        timestamp(20 + i),
      );
    }

    const rail = new FakeRail();
    rail.bindings.set(origin, boundConversation("conversation-claim"));
    const claim = new PendingCompletionClaim(new DurableCompletionWake(rail, host), host);

    expect(await claim.claimForInteraction(dmSurface(221))).toBe(PENDING_COMPLETIONS_PER_CLAIM_CAP);
    expect(rail.enqueued.length).toBe(PENDING_COMPLETIONS_PER_CLAIM_CAP);
    for (let i = 0; i < PENDING_COMPLETIONS_PER_CLAIM_CAP; i++) {
      expect(rail.enqueued[i]!.content).toContain(`result ${i}`);
    }
    for (let i = 0; i < total; i++) {
      const expected = i < PENDING_COMPLETIONS_PER_CLAIM_CAP ? "delivered" : "pending";
      expect(host.loadRecord(`claim-cap-${i}`)!.invocations[0]!.deliveryState).toBe(expected);
    }

    // The unclaimed remainder stays pending for the next interaction.
    expect(await claim.claimForInteraction(dmSurface(221))).toBe(2);
    expect(host.loadRecord(`claim-cap-${total - 1}`)!.invocations[0]!.deliveryState).toBe(
      "delivered",
    );
  });

  it("startup re-arms delivery for bound origin Surfaces and leaves unbound ones waiting", async () => {
    const home = tempHome();
    const boundOrigin = surfaceId(dmSurface(231));
    const unboundOrigin = surfaceId(dmSurface(232));
    const guestOrigin = surfaceId(guestSurface(233));
    const host = new DelegatedWorkHost(home);
    const store = new DelegatedWorkRecordStore(home);
    const setups: Array<[string, SurfaceId, string]> = [
      ["claim-rearm-bound", boundOrigin, "bound origin result"],
      ["claim-rearm-unbound", unboundOrigin, "unbound origin result"],
      ["claim-rearm-guest", guestOrigin, "guest origin result"],
    ];
    for (const [runId, origin, text] of setups) {
      store.createRecord(runId, "generic-subagent", null, 1, durableOwnership(origin), timestamp(0));
      store.closeInvocation(
        runId,
        0,
        "completed",
        { kind: "success", text },
        "pending",
        timestamp(20),
      );
    }

    const rail = new FakeRail();
    rail.bindings.set(boundOrigin, boundConversation("conversation-bound"));
    rail.bindings.set(guestOrigin, boundConversation("conversation-guest"));
    const claim = new PendingCompletionClaim(new DurableCompletionWake(rail, host), host);

    expect(await claim.rearmAtStartup()).toBe(1);
    expect(rail.enqueued.length).toBe(1);
    expect(surfaceId(rail.enqueued[0]!.surface)).toBe(boundOrigin);
    expect(rail.enqueued[0]!.content).toContain("bound origin result");
    expect(host.loadRecord("claim-rearm-bound")!.invocations[0]!.deliveryState).toBe("delivered");
    expect(host.loadRecord("claim-rearm-unbound")!.invocations[0]!.deliveryState).toBe("pending");
    // A guest Surface never re-arms at startup: claiming requires a summon.
    expect(host.loadRecord("claim-rearm-guest")!.invocations[0]!.deliveryState).toBe("pending");
  });

  it("a guest surface cannot claim pending completions without an authorized summon", async () => {
    const home = tempHome();
    const guest = surfaceId(guestSurface(241));
    const host = new DelegatedWorkHost(home);
    const store = new DelegatedWorkRecordStore(home);
    store.createRecord("claim-guest", "generic-subagent", null, 1, durableOwnership(guest), timestamp(0));
    store.closeInvocation(
      "claim-guest",
      0,
      "completed",
      { kind: "success", text: "guest origin result" },
      "pending",
      timestamp(20),
    );

    const rail = new FakeRail();
    rail.bindings.set(guest, boundConversation("conversation-claim"));
    const claim = new PendingCompletionClaim(new DurableCompletionWake(rail, host), host);

    // The ordinary-interaction path refuses guest Surfaces even when bound.
    expect(await claim.claimForInteraction(guestSurface(241))).toBe(0);
    expect(rail.enqueued.length).toBe(0);
    expect(host.loadRecord("claim-guest")!.invocations[0]!.deliveryState).toBe("pending");

    // Summon authorization is guest-only: a non-guest Surface cannot summon.
    expect(await claim.claimForGuestSummon(dmSurface(242))).toBe(0);
    expect(rail.enqueued.length).toBe(0);
    expect(host.loadRecord("claim-guest")!.invocations[0]!.deliveryState).toBe("pending");

    // An authorized summon from the same guest SurfaceId claims.
    expect(await claim.claimForGuestSummon(guestSurface(241))).toBe(1);
    expect(surfaceId(rail.enqueued[0]!.surface)).toBe(guest);
    expect(rail.enqueued[0]!.content).toContain("guest origin result");
    expect(host.loadRecord("claim-guest")!.invocations[0]!.deliveryState).toBe("delivered");
  });
});
