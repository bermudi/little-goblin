import { DelegatedWorkHost } from "../delegated-work/host.ts";
import type { DurableDelegatedWorkOwnership } from "../delegated-work/types.ts";
import {
  ExternalAgentHost,
  type AcpAgentConnection,
  type AcpHostEvent,
  type AcpPromptOutcome,
} from "./host.ts";
import { errorString } from "./util.ts";

/**
 * Completed-context follow-up (decision 0044): one deep module owns the
 * record-first continuation path for external-agent runs. Run authority and
 * delivery stay in the delegated-work subsystem — this module goes through
 * `DelegatedWorkHost` and never writes record files directly.
 *
 * Follow-up targets a completed run's provider context only: the prior
 * invocation stays terminally closed and follow-up appends a new invocation
 * on the same record. Owner-Conversation authority (decision 0036) governs
 * who may continue — the follow-up ownership must belong to the completed
 * invocation's owner Conversation. A run stopped at `input_required` stays
 * running on its returned live connection for the caller to message.
 */

/** Follow-up refused before any provider contact: no invocation appended, no process spawned. */
export class ContinuationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuationRefusedError";
  }
}

export interface ContinueExternalRunRequest {
  workHost: DelegatedWorkHost;
  agentHost: ExternalAgentHost;
  runId: string;
  /** Follow-up prompt text continued in the persisted provider context. */
  prompt: string;
  /** Ownership of the appended invocation; its owner Conversation must match the completed one. */
  ownership: DurableDelegatedWorkOwnership;
  /** Allowlist child environment (decision 0041); the host adds nothing. */
  env: Record<string, string>;
  signal?: AbortSignal;
  emit?: (event: AcpHostEvent) => void;
}

export interface ContinuedExternalRun {
  outcome: AcpPromptOutcome;
  /**
   * Live connection when the follow-up turn awaits input (`input_required`);
   * the invocation stays running and the caller owns the connection. Null
   * when the turn settled — the invocation was closed and the connection
   * disposed.
   */
  live: AcpAgentConnection | null;
}

export async function continueExternalRun(request: ContinueExternalRunRequest): Promise<ContinuedExternalRun> {
  const { workHost, agentHost, runId } = request;
  if (request.prompt.trim().length === 0) {
    throw new ContinuationRefusedError("follow-up requires non-empty prompt text");
  }
  const record = workHost.loadRecord(runId);
  if (record === null) {
    throw new ContinuationRefusedError(`external run ${runId} not found`);
  }
  if (record.kind !== "external-agent") {
    throw new ContinuationRefusedError(`run ${runId} is ${record.kind}, not an external-agent run`);
  }
  const last = record.invocations.at(-1);
  if (last === undefined || last.status !== "completed") {
    throw new ContinuationRefusedError(
      `follow-up refused: invocation ${last?.index ?? "?"} of ${runId} is ${last?.status ?? "missing"}; only a completed run continues, never a lost active turn`,
    );
  }
  const providerSessionId = record.external.providerSessionId;
  if (providerSessionId === null) {
    throw new ContinuationRefusedError(`follow-up refused: run ${runId} has no captured provider session`);
  }
  if (request.ownership.ownerConversationId !== last.ownerConversationId) {
    throw new ContinuationRefusedError(
      `follow-up refused: run ${runId} is owned by Conversation ${last.ownerConversationId}`,
    );
  }
  const workingDirectory = record.external.workingDirectory;
  if (workingDirectory === undefined) {
    throw new ContinuationRefusedError(`follow-up refused: run ${runId} captured no working directory`);
  }
  const backend = record.external.backend;

  // Capability failures (including a missing operator-owned Devin model) throw
  // here, before any invocation is appended — the record is untouched.
  const connection = await agentHost.continueSession({
    backend,
    workingDirectory,
    permissionProfile: record.external.permissionProfile ?? "dangerous",
    env: request.env,
    ...(backend === "devin" ? { devinModel: record.external.devinModel ?? undefined } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    providerSessionId,
  });

  let followupIndex: number;
  try {
    followupIndex = workHost.appendExternalFollowup(runId, request.ownership).record.invocations.length - 1;
  } catch (err) {
    await connection.dispose().catch(() => {});
    throw err;
  }

  let outcome: AcpPromptOutcome;
  try {
    outcome = await connection.prompt(request.prompt, request.emit ?? (() => {}));
  } catch (err) {
    try {
      workHost.failInvocation(runId, followupIndex, errorString(err));
    } catch {
      // The record failure is already logged by the store; report the prompt error.
    }
    await connection.dispose().catch(() => {});
    throw err;
  }
  if (outcome.stopReason === "input_required") {
    return { outcome, live: connection };
  }
  try {
    workHost.completeInvocation(runId, followupIndex, outcome.agentText);
  } catch (err) {
    // Coordinator-owned failure: never leave a running record behind a dead turn.
    try {
      workHost.failInvocation(runId, followupIndex, errorString(err));
    } catch {
      // The record failure is already logged by the store; report the completion error.
    }
    await connection.dispose().catch(() => {});
    throw err;
  }
  await connection.dispose().catch(() => {});
  return { outcome, live: null };
}
