import type { ChatLocator } from "../sessions/types.ts";

export type MemoryScope =
  | "general"
  | { topic: { chatId: number; topicId: number } }
  | { agent: { name: string } };

export interface ActiveScope {
  topicScope: { chatId: number; topicId: number } | "general";
  namedAgent: { name: string } | null;
}

export function resolveActiveScope(locator: ChatLocator, namedAgent?: string): ActiveScope {
  return {
    topicScope:
      locator.topicId === undefined
        ? "general"
        : { chatId: locator.chatId, topicId: locator.topicId },
    namedAgent: namedAgent === undefined ? null : { name: namedAgent },
  };
}

export function scopeTag(scope: MemoryScope | "user"): string {
  if (scope === "user" || scope === "general") return scope;
  if ("topic" in scope) {
    return `topics/${scope.topic.chatId}/${scope.topic.topicId}`;
  }
  return `agents/${scope.agent.name}`;
}
