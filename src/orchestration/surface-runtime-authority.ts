import type { AgentRunner } from "../agent/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import type { Surface } from "../surface.ts";

/** Signal used while attached work acquires its runtime-owned resources. */
export interface AttachmentSignal {
  readonly settled: boolean;
  attached(): void;
  failed(err: unknown): void;
}

/** Work returned after the lifecycle guard releases its transition lock. */
export interface AttachedWork<T> {
  result: Promise<T>;
  runner?: AgentRunner;
}

/** Lifecycle guard that excludes Binding replacement until work is attached. */
export interface CurrentBindingGuard {
  withCurrentBinding<T>(
    surface: Surface,
    conversationId: ConversationId,
    fn: (signal: AttachmentSignal) => Promise<AttachedWork<T>>,
  ): Promise<AttachedWork<T>>;
}

/**
 * Lifecycle-owned authority used by every Surface-backed runtime effect.
 * Asynchronous checks reconcile pending transitions; the synchronous check is
 * closed over by AgentRunner so stale work fails before producing effects.
 */
export interface SurfaceRuntimeAuthority extends CurrentBindingGuard {
  assertCurrentBinding(surface: Surface, conversationId: ConversationId): Promise<void>;
  isCurrentBinding(surface: Surface, conversationId: ConversationId): boolean;
}
