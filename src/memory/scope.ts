import type { ChatLocator } from "../sessions/types.ts";

export type MemoryScope =
  | "general"
  | { topic: { chatId: number; topicId: number } }
  | { agent: { name: string } };

export interface ActiveScope {
  /** Binding context: which chat this session is in (DM, supergroup, or forum). */
  chatId: number;
  /** Memory scope: general (no topic) or specific topic within the chat. */
  topicScope: { topicId: number } | "general";
  namedAgent: { name: string } | null;
}

export function resolveActiveScope(locator: ChatLocator, namedAgent?: string): ActiveScope {
  return {
    chatId: locator.chatId,
    topicScope:
      locator.topicId === undefined
        ? "general"
        : { topicId: locator.topicId },
    namedAgent: namedAgent ? { name: namedAgent } : null,
  };
}

export function scopeTag(scope: MemoryScope | "user"): string {
  if (scope === "user" || scope === "general") return scope;
  if ("topic" in scope) {
    return `topics/${scope.topic.chatId}/${scope.topic.topicId}`;
  }
  return `agents/${scope.agent.name}`;
}
