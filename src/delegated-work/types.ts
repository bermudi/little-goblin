import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { ConversationId } from "../sessions/types.ts";
import type { SurfaceId } from "../surface.ts";

/** Ephemeral identity of one ConversationRuntime generation. */
export type ConversationRuntimeId = string & { readonly __conversationRuntimeId: unique symbol };

/** Runtime authority captured by a Surface-backed delegated invocation. */
export interface DelegatedRuntimeContext {
  readonly ownerConversationId: ConversationId;
  readonly runtimeId: ConversationRuntimeId;
  readonly originSurfaceId: SurfaceId;
  readonly executionEnvironment: ExecutionEnvironment;
}

/**
 * Ownership for the first delegated-work slice. The lifetime is deliberately
 * not model input: generic subagents are attached by code because their result
 * is returned through the blocking caller.
 */
export interface AttachedDelegatedWorkOwnership extends DelegatedRuntimeContext {
  readonly lifetime: "attached";
  /** One immutable root epoch shared by recursively spawned children. */
  readonly ownershipEpochId: string;
}

export type DelegatedDeliveryState = "pending" | "delivered" | "suppressed";

export type DelegatedWorkKind = "generic-subagent" | "named-subagent";

export type DelegatedWorkStatus = "running" | "completed" | "cancelled" | "error" | "interrupted";

export type DelegatedWorkOutcome =
  | { readonly kind: "success"; readonly text: string }
  | { readonly kind: "error"; readonly errorMessage: string };

/** One appended entry in a delegated run's invocation log. */
export interface DelegatedWorkInvocation {
  readonly index: number;
  readonly ownerConversationId: string;
  readonly runtimeId: string;
  readonly ownershipEpochId: string;
  readonly lifetime: "attached";
  readonly originSurfaceId: string;
  readonly executionEnvironment: ExecutionEnvironment;
  readonly status: DelegatedWorkStatus;
  readonly outcome: DelegatedWorkOutcome | null;
  readonly deliveryState: DelegatedDeliveryState;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/**
 * Host-owned record for one delegated run.
 *
 * A record is a stable identity (id, kind, optional name, creation time) plus
 * an append-only log of invocations. Each invocation captures the ownership
 * contract from decision 0036: owner Conversation, runtime identity, epoch,
 * lifetime, origin Surface, and Execution Environment, plus terminal outcome and
 * delivery state.
 */
export interface DelegatedWorkRecord {
  readonly id: string;
  readonly kind: DelegatedWorkKind;
  readonly name: string | null;
  readonly depth: number;
  readonly createdAt: string;
  readonly invocations: readonly DelegatedWorkInvocation[];
}

/**
 * Adapter boundary owned by an execution coordinator. The host owns policy;
 * the adapter owns the mechanics of fencing and stopping its invocation.
 */
export interface AttachedWorkAdapter {
  /** Synchronously prevent late effects and descendant registration. */
  fence(): void;
  /** Destructively stop the invocation and its owned execution tree. */
  cancel(): Promise<void>;
  /** Resolve only after the adapter can prove no effects remain possible. */
  quiesce(): Promise<void>;
}

export interface AttachedWorkRegistration {
  readonly runId: string;
  readonly ownership: AttachedDelegatedWorkOwnership;
  /** True after host or adapter fencing has won the race. */
  readonly fenced: boolean;
  /** Attach execution mechanics before the invocation is started. */
  attach(adapter: AttachedWorkAdapter): void;
  /** Remove a reservation after terminal completion or setup failure. */
  release(): void;
}

export function asConversationRuntimeId(value: string): ConversationRuntimeId {
  if (value.length === 0) throw new Error("Conversation runtime id must not be empty");
  return value as ConversationRuntimeId;
}
