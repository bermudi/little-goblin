import type {
  ConversationCreationLease,
  ConversationLifecycle,
} from "../orchestration/conversation-lifecycle.ts";
import {
  runtimeAdmission,
  type AdmissionResult,
  type RuntimeAdmissionResult,
} from "../shutdown/mod.ts";

/**
 * Chain a continuation after a runtime admission's completion while
 * preserving the structural decision kind. The structural decision
 * (handoff/busy/fenced/rejected) is already authoritative at the
 * admission call; the continuation runs in the completion so the
 * runtime-admission drain releases immediately and shutdown disposal
 * can cancel a stalled runner creation rather than deadlocking on the
 * admission drain (decision 0046).
 *
 * A rejected admission is terminal: the continuation is not invoked and
 * no follow-on side effects are started from it. The mapped completion
 * settles without consuming the rejected value.
 */
export function mapAdmissionCompletion<T>(
  admission: RuntimeAdmissionResult<T>,
  continuation: (value: T) => Promise<void>,
): RuntimeAdmissionResult<void> {
  if (admission.kind === "rejected") {
    // Preserve the rejection as a terminal failure: the continuation is not
    // invoked and the mapped completion rejects so the caller can suppress
    // success delivery. The original completion is observed to avoid
    // unhandled rejections.
    void admission.completion.then(() => undefined, () => undefined);
    return runtimeAdmission.rejected(Promise.reject(new Error("command side-effect rejected after handoff")));
  }
  const completion = admission.completion.then(continuation);
  switch (admission.kind) {
    case "handoff": return runtimeAdmission.handoff(completion);
    case "busy": return runtimeAdmission.busy(completion);
    case "fenced": return runtimeAdmission.fenced(completion);
  }
}

/** Release one lifecycle-issued rejected creation lease with caller context. */
export async function releaseRejectedCreation(
  lifecycle: ConversationLifecycle,
  lease: ConversationCreationLease,
  context: string,
): Promise<void> {
  let applied: boolean;
  try {
    applied = await lifecycle.releaseCreation(lease);
  } catch (cause) {
    throw new Error(`failed to release rejected creation lease after ${context}`, { cause });
  }
  if (!applied) {
    throw new Error(
      `creation lease release/rollback was not applied after ${context}; lease was already settled or no safe final rollback mutation applied`,
    );
  }
}

/**
 * Preserve an authoritative structural rejection while attaching creation
 * lease release (and any final authorized rollback) to its completion.
 */
export function withRejectedCreationRelease<T>(
  admission: AdmissionResult<T>,
  lease: ConversationCreationLease | null,
  lifecycle: ConversationLifecycle,
  source: string,
): AdmissionResult<T> {
  if (lease === null) return admission;

  const context = `${source} admission (${admission.kind}) for Surface ${lease.surfaceId} and Conversation ${lease.conversationId}`;
  const release = releaseRejectedCreation(lifecycle, lease, context);
  const completion = release.then(
    () => admission.completion,
    async (releaseError: unknown) => {
      try {
        await admission.completion;
      } catch (completionError) {
        throw new AggregateError(
          [releaseError, completionError],
          `Conversation creation release and ${source} admission completion both failed`,
        );
      }
      throw releaseError;
    },
  );
  return { kind: admission.kind, completion };
}

/**
 * Synchronous dispatcher throws happen before a structural decision. Release
 * the observer lease first, then rethrow the admission error; if release or
 * final rollback also fails, preserve both causes in admission-first order.
 */
export async function attemptCreationAdmission<T>(
  admit: () => T,
  lease: ConversationCreationLease | null,
  lifecycle: ConversationLifecycle,
  source: string,
): Promise<T> {
  try {
    return admit();
  } catch (admissionError) {
    if (lease === null) throw admissionError;
    const context = `${source} admission throw for Surface ${lease.surfaceId} and Conversation ${lease.conversationId}`;
    try {
      await releaseRejectedCreation(lifecycle, lease, context);
    } catch (releaseError) {
      throw new AggregateError(
        [admissionError, releaseError],
        `Conversation admission and creation release both failed for ${source}`,
      );
    }
    throw admissionError;
  }
}
