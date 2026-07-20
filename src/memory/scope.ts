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
    namedAgent: namedAgent !== undefined && namedAgent.length > 0
      ? { name: namedAgent }
      : null,
  };
}

/**
 * Convert an `ActiveScope` to its memory scope. General scopes (no topic) map
 * to `"general"`; topic scopes map to the `{ topic: { chatId, topicId } }`
 * memory scope. The `namedAgent` field does not affect this conversion — agent
 * scopes are produced by the memory tools' `target: "agent"` path, not by the
 * active scope.
 *
 * The single home for this conversion; was previously duplicated byte-for-byte
 * in `reflector.ts`, `snapshot.ts`, `search.ts`, and `tool.ts`.
 */
export function activeMemoryScopeFor(activeScope: ActiveScope): MemoryScope {
  if (activeScope.topicScope === "general") return "general";
  return {
    topic: {
      chatId: activeScope.chatId,
      topicId: activeScope.topicScope.topicId,
    },
  };
}

export function scopeTag(scope: MemoryScope | "user"): string {
  if (scope === "user" || scope === "general") return scope;
  if ("topic" in scope) {
    return `topics/${scope.topic.chatId}/${scope.topic.topicId}`;
  }
  return `agents/${scope.agent.name}`;
}

export type MemoryScopePair = { scope: string; entry_kind: "memory" | "user" };

export function tagToMemoryScope(tag: string): MemoryScope | "user" | "archive" {
  if (tag === "user" || tag === "general") return tag;
  if (tag.startsWith("topics/")) {
    const parts = tag.split("/");
    if (parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined) {
      const chatId = Number.parseInt(parts[1], 10);
      const topicId = Number.parseInt(parts[2], 10);
      if (Number.isFinite(chatId) && Number.isFinite(topicId)) {
        return { topic: { chatId, topicId } };
      }
    }
  }
  if (tag.startsWith("agents/")) {
    const name = tag.slice("agents/".length);
    if (name.length > 0) return { agent: { name } };
  }
  return "archive";
}
