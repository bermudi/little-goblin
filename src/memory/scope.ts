import type { Surface } from "../surface.ts";

export type MemoryScope =
  | "general"
  | { topic: { chatId: number; topicId: number } }
  | { agent: { name: string } };

/**
 * Surface-derived active memory authority.
 *
 * `ActiveScope` carries only routing facts: the Telegram `chatId` that bounds
 * cross-scope discovery and transcript filtering, plus the projected topic
 * scope (a specific topic or the singleton `"general"` lane). Persona identity
 * is NOT part of `ActiveScope` — it lives in `MemoryCaller`, the sole
 * persona/visibility authority. Keeping persona out of `ActiveScope` prevents
 * impossible states where a deterministic Surface projection disagrees with
 * caller identity.
 */
export interface ActiveScope {
  /** Telegram chat ID — the discovery and transcript-filter boundary. */
  chatId: number;
  /** Memory scope: a specific topic within the chat, or the singleton `"general"` lane. */
  topicScope: { topicId: number } | "general";
}

/**
 * Project a validated Telegram `Surface` to its `ActiveScope`.
 *
 * This is the single home of `Surface → ActiveScope`. Every topic container
 * (private, supergroup, direct-messages) projects to `{ chatId, topicScope: { topicId } }`;
 * DM, topicless supergroup, and guest all project to `{ chatId, topicScope: "general" }`.
 * The `chatId` is retained even for `"general"` because curated scope and
 * transcript/discovery boundary are different facts.
 *
 * `ActiveScope` carries no named-agent identity. Caller kind and optional
 * persona name remain in `MemoryCaller` (see `src/memory/context.ts`), which is
 * the sole persona/visibility authority. Internal callers MUST NOT call this
 * function — they use an explicit Surface-free internal context instead.
 */
export function resolveActiveScope(surface: Surface): ActiveScope {
  switch (surface.kind) {
    case "dm":
    case "supergroup":
    case "guest":
      return { chatId: surface.chatId, topicScope: "general" };
    case "topic":
      return { chatId: surface.chatId, topicScope: { topicId: surface.topicId } };
  }
}

/**
 * Convert an `ActiveScope` to its memory scope. General scopes (no topic) map
 * to `"general"`; topic scopes map to the `{ topic: { chatId, topicId } }`
 * memory scope. Persona identity is not part of `ActiveScope` — agent scopes
 * are produced by the memory tools' `target: "agent"` path through the caller
 * descriptor, not by the active scope.
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

export type MemoryScopePair = {
  scope: string;
  entry_kind: "memory" | "user";
  chatId: string | null;
};

function entryKindForScope(scope: MemoryScope | "user" | "memory"): "memory" | "user" {
  return scope === "user" ? "user" : "memory";
}

function chatIdForScope(scope: MemoryScope | "user" | "memory"): string | null {
  if (scope === "user" || scope === "general" || scope === "memory") return null;
  if ("topic" in scope) return String(scope.topic.chatId);
  return null;
}

/**
 * Convert a memory scope to the three database-facing values that every
 * consumer needs: scope tag, entry_kind, and chat_id. This is the single home
 * for the conversion; was previously duplicated in `store.ts` and `dreaming.ts`.
 */
export function toMemoryScopePair(scope: MemoryScope | "user" | "memory"): MemoryScopePair {
  const normalized = scope === "memory" ? "general" : scope;
  return {
    scope: scopeTag(normalized),
    entry_kind: entryKindForScope(normalized),
    chatId: chatIdForScope(normalized),
  };
}

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
