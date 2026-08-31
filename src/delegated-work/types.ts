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
 * Attached ownership for the first delegated-work slice. The runtime identity
 * is the fence key: runtime invalidation cancels attached work.
 */
export interface AttachedDelegatedWorkOwnership extends DelegatedRuntimeContext {
  readonly lifetime: "attached";
  /** One immutable root epoch shared by recursively spawned children. */
  readonly ownershipEpochId: string;
}

/**
 * Durable ownership (decision 0036): the run is not owned by a Conversation
 * runtime. The captured runtime identity is spawn-time provenance only —
 * runtime invalidation and Conversation rotation must not cancel, fence, or
 * retarget durable registrations; explicit owner cancellation stays the only
 * destructive authority.
 */
export interface DurableDelegatedWorkOwnership extends DelegatedRuntimeContext {
  readonly lifetime: "durable";
  /** One immutable root epoch shared by recursively spawned durable children. */
  readonly ownershipEpochId: string;
}

export type DelegatedWorkOwnership =
  | AttachedDelegatedWorkOwnership
  | DurableDelegatedWorkOwnership;

export type DelegatedDeliveryState = "pending" | "delivered" | "suppressed";

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

/**
 * Registration handle for one delegated-work reservation. The ownership type
 * parameter is attached for attached reservations and durable for durable
 * reservations; the fence/attach/release mechanics are shared.
 */
export interface DelegatedWorkRegistration<O extends DelegatedWorkOwnership = DelegatedWorkOwnership> {
  readonly runId: string;
  readonly ownership: O;
  /** True after host or adapter fencing has won the race. */
  readonly fenced: boolean;
  /** Attach execution mechanics before the invocation is started. */
  attach(adapter: AttachedWorkAdapter): void;
  /** Remove a reservation after terminal completion or setup failure. */
  release(): void;
}

export type AttachedWorkRegistration = DelegatedWorkRegistration<AttachedDelegatedWorkOwnership>;
export type DurableWorkRegistration = DelegatedWorkRegistration<DurableDelegatedWorkOwnership>;

export function asConversationRuntimeId(value: string): ConversationRuntimeId {
  if (value.length === 0) throw new Error("Conversation runtime id must not be empty");
  return value as ConversationRuntimeId;
}
