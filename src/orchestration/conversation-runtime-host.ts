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
export interface ConversationRuntimeHost {
  disposeRuntime(conversationId: ConversationId): Promise<void>;
}

/**
 * Create a runtime host backed by a TurnDispatcher.
 *
 * Conversation ids share the 10-hex shape with legacy session ids, so the
 * dispatcher's per-session runner/queue maps can be keyed by conversation id
 * during the migration.
 */
export function createTurnDispatcherRuntimeHost(dispatcher: TurnDispatcher): ConversationRuntimeHost {
  return {
    disposeRuntime: (conversationId) => dispatcher.disposeRunner(conversationId),
  };
}
