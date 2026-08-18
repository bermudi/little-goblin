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
