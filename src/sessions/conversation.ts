import { randomUUID } from "node:crypto";
import type { ConversationId, ConversationState, SessionState } from "./types.ts";
import type { Surface } from "../surface.ts";
import { getModelName, getThinkingLevelValidated } from "./topic-settings.ts";

/**
 * A goblin-generated conversation id is 10 chars of lowercase hex (0-9a-f). It
 * is filesystem-safe and matches the legacy session id format so conversation
 * records can reuse `state/sessions/<id>/` paths.
 */
const CONVERSATION_ID_HEX_RE = /^[0-9a-f]{10}$/;

/**
 * Reject conversation ids that do not match the goblin-generated hex format.
 * This single validation is also a path-traversal guard: any value containing
 * `..`, path separators, or non-hex characters fails the same hex check.
 */
export function validateConversationId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid conversation id: must be a non-empty string`);
  }
  if (!CONVERSATION_ID_HEX_RE.test(id)) {
    throw new Error(`Invalid conversation id: must be 10 lowercase hex characters`);
  }
}

/** True when `id` is a syntactically valid conversation id. */
export function isValidConversationId(id: string): id is ConversationId {
  return CONVERSATION_ID_HEX_RE.test(id);
}

/**
 * Generate a short URL-safe conversation ID from a UUID.
 * 10 chars of hex (0-9a-f), fs-safe. 16^10 ≈ 1.1 trillion combos.
 */
export function makeConversationId(): ConversationId {
  const hex = randomUUID().replace(/-/g, "");
  return hex.slice(0, 10) as ConversationId;
}

/**
 * Build a runtime-only `SessionState` from a canonical `ConversationState` and
 * a destination `Surface`. The result is not persisted; it carries the Telegram
 * address of the *current* binding so the dispatcher can construct the right
 * tools, sink, and memory scope. Model/thinking/project fields are left unset
 * here and filled from Surface settings before runner construction.
 */
export function runtimeSession(conversation: ConversationState, surface: Surface): SessionState {
  return {
    ...conversation,
    chatId: surface.chatId,
    topicId: surface.kind === "topic" ? surface.topicId : undefined,
  };
}

/**
 * Build a runtime `SessionState` for the current Surface, merging the durable
 * Conversation with Surface-scoped preferences (model, thinking level). This is
 * the single place that couples runtime session construction to surface
 * settings; commands and the lifecycle only see canonical Conversation state.
 */
export function runtimeSessionWithPreferences(
  conversation: ConversationState,
  surface: Surface,
  home: string,
): SessionState {
  const session = runtimeSession(conversation, surface);
  session.modelName = getModelName(home, surface);
  session.thinkingLevel = getThinkingLevelValidated(home, surface);
  return session;
}
