/**
 * Decision-0036 pending-claim protocol for durable delegated runs.
 *
 * A durable completion that could not be delivered (origin Surface unbound at
 * completion, send rejected or fenced, or delivery still pending across a
 * process restart) stays pending on its record for its exact origin SurfaceId.
 * This module claims those retained completions: an authorized ordinary
 * interaction on the exact Surface, an authorized guest summon from the same
 * guest SurfaceId, or a startup re-arm for origin Surfaces that are currently
 * bound. Claims deliver oldest-first under a fixed per-claim cap through the
 * same surface-bound system-turn rail as the completion wake — no fallback
 * routing, no Conversation creation, no proactive contact to other lanes, and
 * guest Surfaces never claim without a summon.
 */

import { boundedError, log } from "../log.ts";
import { parseSurfaceId, surfaceId, type GuestSurface, type Surface } from "../surface.ts";
import type { DelegatedWorkHost } from "./host.ts";
import { DurableCompletionWake } from "./delivery.ts";

/**
 * Named per-claim cap. One claim delivers at most this many retained
 * completions, oldest-first; the unclaimed remainder stays pending for the
 * next claim.
 */
export const PENDING_COMPLETIONS_PER_CLAIM_CAP = 3;

/** One retained pending durable completion, addressable on its record. */
export interface PendingCompletionRef {
  readonly runId: string;
  readonly index: number;
  readonly originSurfaceId: string;
  readonly completedAt: string;
}

function oldestFirst(a: PendingCompletionRef, b: PendingCompletionRef): number {
  if (a.completedAt !== b.completedAt) return a.completedAt < b.completedAt ? -1 : 1;
  if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
  return a.index - b.index;
}

/**
 * Deep boundary for the pending-claim half of decision-0036 delivery. Owns
 * retention enumeration, exact-Surface attribution, claim authorization, the
 * per-claim cap, and startup re-arm. Delivery and acknowledgement ride the
 * completion wake, so a claimed completion becomes delivered only after the
 * rail turn settles successfully.
 */
export class PendingCompletionClaim {
  private readonly wake: DurableCompletionWake;
  private readonly host: DelegatedWorkHost;

  constructor(wake: DurableCompletionWake, host: DelegatedWorkHost) {
    this.wake = wake;
    this.host = host;
  }

  /**
   * Retained pending durable completions for one exact SurfaceId,
   * oldest-first. Callers inspect; claiming goes through the authorized
   * entries below.
   */
  listPendingForSurface(originSurfaceId: string): PendingCompletionRef[] {
    parseSurfaceId(originSurfaceId);
    return this.listAllPending().filter((ref) => ref.originSurfaceId === originSurfaceId);
  }

  /**
   * Claim on an authorized ordinary interaction. Only completions retained
   * for this exact Surface are claimed. Guest Surfaces never claim here —
   * they require an authorized guest summon (`claimForGuestSummon`).
   */
  async claimForInteraction(surface: Surface): Promise<number> {
    if (surface.kind === "guest") {
      log.info("pending claim refused: guest Surface requires an authorized summon", {
        surfaceId: surfaceId(surface),
      });
      return 0;
    }
    return this.claimSurface(surfaceId(surface));
  }

  /**
   * Claim on an authorized guest summon from the same guest SurfaceId.
   * Summon authorization is guest-only: a non-guest Surface cannot summon.
   */
  async claimForGuestSummon(surface: Surface): Promise<number> {
    if (surface.kind !== "guest") return 0;
    return this.claimSurface(surfaceId(surface), surface);
  }

  /**
   * Startup re-arm. Retained completions whose origin Surface is currently
   * bound are re-delivered without waiting for interaction; unbound ones stay
   * pending, and guest Surfaces are skipped — they claim only via summon.
   * Binding resolution happens inside the wake, so this is safe before any
   * interaction has arrived.
   */
  async rearmAtStartup(): Promise<number> {
    const bySurface = new Map<string, PendingCompletionRef[]>();
    for (const ref of this.listAllPending()) {
      const group = bySurface.get(ref.originSurfaceId);
      if (group === undefined) bySurface.set(ref.originSurfaceId, [ref]);
      else group.push(ref);
    }
    let delivered = 0;
    for (const [originSurfaceId] of bySurface) {
      if (parseSurfaceId(originSurfaceId).kind === "guest") {
        log.info("pending claim re-arm skipped: guest Surface requires an authorized summon", {
          surfaceId: originSurfaceId,
        });
        continue;
      }
      delivered += await this.claimSurface(originSurfaceId);
    }
    return delivered;
  }

  /**
   * Claim up to the cap for one exact SurfaceId, oldest-first.
   */
  private async claimSurface(
    originSurfaceId: string,
    summonedGuestSurface: GuestSurface | null = null,
  ): Promise<number> {
    const refs = this.listPendingForSurface(originSurfaceId)
      .slice(0, PENDING_COMPLETIONS_PER_CLAIM_CAP);
    let delivered = 0;
    for (const ref of refs) {
      const outcome = summonedGuestSurface === null
        ? await this.wake.deliverCompletion(ref.runId, ref.index)
        : await this.wake.deliverGuestSummonCompletion(ref.runId, ref.index, summonedGuestSurface);
      if (outcome === "delivered") delivered++;
    }
    return delivered;
  }

  /**
   * Every retained pending durable completion across the record store,
   * oldest-first. One malformed record is skipped with a log so a single
   * corrupt file cannot hold every retained completion hostage (same policy
   * as startup reconciliation); missing records are absence, everything else
   * propagates.
   */
  private listAllPending(): PendingCompletionRef[] {
    const refs: PendingCompletionRef[] = [];
    for (const runId of this.host.listRecordIds()) {
      let record;
      try {
        record = this.host.loadRecord(runId);
      } catch (error) {
        log.error("delegated work pending claim skipped a run", {
          runId,
          ...boundedError(error),
        });
        continue;
      }
      if (record === null) continue;
      for (const invocation of record.invocations) {
        if (invocation.lifetime !== "durable") continue;
        if (invocation.status !== "completed") continue;
        if (invocation.deliveryState !== "pending") continue;
        if (invocation.completedAt === null) {
          throw new Error(
            `Completed durable invocation ${runId}/${invocation.index} has no completion timestamp`,
          );
        }
        refs.push({
          runId,
          index: invocation.index,
          originSurfaceId: invocation.originSurfaceId,
          completedAt: invocation.completedAt,
        });
      }
    }
    return refs.sort(oldestFirst);
  }
}
