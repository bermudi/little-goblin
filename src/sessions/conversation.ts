import { randomUUID } from "node:crypto";
import type { ConversationId } from "./types.ts";

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
