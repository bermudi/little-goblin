/**
 * Decision-0036 completion wake for durable delegated runs.
 *
 * When a durable invocation closes `completed` with delivery pending, this
 * module delivers the result to the run's exact origin Surface through the
 * surface-bound system-turn rail (scheduled turns). It never creates a
 * Conversation (decision 0033), never routes to a different Surface that
 * merely shares the Conversation, environment, or CWD, and never auto-delivers
 * a failed execution. Delivery state transitions pending→delivered only after
 * the send is accepted; a rejected or fenced send leaves the completion
 * pending for the pending-claim protocol.
 */

import { log } from "../log.ts";
import { parseSurfaceId, type Surface } from "../surface.ts";
import type { ConversationState } from "../sessions/types.ts";
import type { DelegatedWorkHost } from "./host.ts";

/**
 * System-owned prefix for the completion wake prompt. Mirrors the
 * `[heartbeat]` convention: the prefix makes the prompt distinguishable from
 * user-authored text at the agent layer and in transcripts, and the body MUST
 * NOT claim a user asked a new question.
 */
export const DELEGATED_COMPLETION_PROMPT_PREFIX = "[delegated-run]";

/**
 * Start handle of an accepted rail admission. Structural twin of the
 * dispatcher's scheduled-turn admission: `started` resolves false when
 * shutdown fences the queued turn before it executes.
 */
export interface WakeTurnAdmission {
  readonly accepted: true;
  readonly started: Promise<boolean>;
}

/**
 * The surface-bound system-turn rail the wake reuses. Narrow seam so this
 * module does not depend on orchestration: production callers bind
 * `ConversationLifecycle.resolveCurrent` (non-creating binding resolution)
 * and `TurnDispatcher.enqueueScheduledTurn` (scheduled turns).
 */
export interface CompletionWakeRail {
  /** Non-creating current-binding inspection for the exact origin Surface. */
  resolveCurrent(surface: Surface): Promise<ConversationState | null>;
  /** Enqueue one system-owned turn through the Surface's current runtime. */
  enqueueScheduledTurn(
    conversation: ConversationState,
    surface: Surface,
    content: string,
  ): boolean | WakeTurnAdmission;
}

export type CompletionWakeOutcome = "delivered" | "pending" | "suppressed";

function completionPrompt(resultText: string): string {
  return (
    `${DELEGATED_COMPLETION_PROMPT_PREFIX} A background subagent you spawned earlier has ` +
    "completed. No user message prompted this turn — this is not a user question. " +
    "Share the subagent's result with the user in your own voice.\n\n" +
    resultText
  );
}

/**
 * Deep boundary for durable completion delivery. Owns the whole wake
 * transition — record inspection, exact-origin binding resolution, rail
 * dispatch, and the delivery-state acknowledgement — so callers never
 * choreograph the sequence themselves.
 */
export class DurableCompletionWake {
  private readonly rail: CompletionWakeRail;
  private readonly host: DelegatedWorkHost;

  constructor(rail: CompletionWakeRail, host: DelegatedWorkHost) {
    this.rail = rail;
    this.host = host;
  }

  /**
   * Attempt wake delivery for one terminal invocation.
   *
   * Returns the observed delivery outcome. `pending` means nothing was sent
   * (origin Surface unbound, rail admission closed, or the turn was fenced
   * before it started) and the completion remains claimable. `suppressed`
   * means the execution failed or was cancelled: failed work is never
   * auto-delivered. Fails loud on records that do not exist and on
   * persistence errors; those propagate to the caller.
   */
  async deliverCompletion(runId: string, index: number): Promise<CompletionWakeOutcome> {
    const record = this.host.loadRecord(runId);
    if (record === null) {
      throw new Error(`Completion wake requires a record for run ${runId}`);
    }
    const invocation = record.invocations[index];
    if (invocation === undefined) {
      throw new Error(`Invocation index ${index} out of bounds for record ${runId}`);
    }
    if (invocation.status === "running") {
      throw new Error(`Completion wake for ${runId} invocation ${index}: still running`);
    }
    if (invocation.deliveryState !== "pending") {
      // Delivered and suppressed invocations have nothing left to wake.
      // Failed and cancelled executions stay suppressed forever.
      return invocation.deliveryState;
    }

    const surface = parseSurfaceId(invocation.originSurfaceId);
    const conversation = await this.rail.resolveCurrent(surface);
    if (conversation === null) {
      log.info("durable completion wake left pending: origin Surface unbound", {
        runId,
        index,
        surfaceId: invocation.originSurfaceId,
      });
      return "pending";
    }

    const resultText = invocation.outcome?.kind === "success" ? invocation.outcome.text : "";
    const admission = this.rail.enqueueScheduledTurn(conversation, surface, completionPrompt(resultText));
    if (typeof admission === "boolean") {
      if (!admission) {
        log.info("durable completion wake left pending: rail admission closed", {
          runId,
          index,
          surfaceId: invocation.originSurfaceId,
        });
        return "pending";
      }
      this.host.acknowledgeDelivery(runId, index);
      return "delivered";
    }
    const started = await admission.started;
    if (!started) {
      log.info("durable completion wake left pending: rail fenced the turn before start", {
        runId,
        index,
        surfaceId: invocation.originSurfaceId,
      });
      return "pending";
    }
    // A terminal transition that won the race between enqueue and
    // acknowledgement (e.g. explicit owner cancellation) keeps its authority:
    // the host rejects the late acknowledgement and the error propagates to
    // the caller instead of overwriting the authoritative delivery state.
    this.host.acknowledgeDelivery(runId, index);
    return "delivered";
  }
}
