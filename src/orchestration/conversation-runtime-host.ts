import type { ConversationId } from "../sessions/types.ts";
import type { TurnDispatcher } from "./dispatcher.ts";

/**
 * Narrow adapter implemented by the TurnDispatcher.
 *
 * A runtime host is authoritative for the in-memory AgentRunner and prompt
 * queue. Lifecycle operations call it before mutating bindings so any queued
 * work captured by a displaced runner is dropped before the runner can produce
 * effects. The invalidation (runner/queue removal) is synchronous; the
 * quiescence (AgentRunner.dispose and subagent/external cleanup) is bounded.
 */
export interface RuntimeDisposalOptions {
  /**
   * Preserve lifecycle-command serialization while invalidating model work.
   * Commands use binding authority rather than the disposed runner's identity.
   */
  readonly preserveCommandQueue?: boolean;
}

export interface ConversationRuntimeHost {
  /** True when a runner or in-flight creation currently holds this identity. */
  hasRuntime(conversationId: ConversationId): boolean;
  disposeRuntime(conversationId: ConversationId, options?: RuntimeDisposalOptions): Promise<void>;
}

/**
 * Create a runtime host backed by a TurnDispatcher.
 *
 * Conversation ids share the 10-hex shape with legacy session ids, so the
 * dispatcher's per-session runner/queue maps can be keyed by conversation id
 * during the migration.
 */
export function createTurnDispatcherRuntimeHost(
  dispatcher: TurnDispatcher | (() => TurnDispatcher),
): ConversationRuntimeHost {
  const getDispatcher = typeof dispatcher === "function" ? dispatcher : () => dispatcher;
  return {
    hasRuntime: (conversationId) => getDispatcher().hasRuntime(conversationId),
    disposeRuntime: (conversationId, options) => getDispatcher().disposeRunner(conversationId, undefined, options),
  };
}
