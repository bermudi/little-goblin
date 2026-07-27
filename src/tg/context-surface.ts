/**
 * Grammy context normalization to `Surface`.
 *
 * This module owns the boundary between Telegram updates and the domain's
 * `Surface` identity. Downstream modules receive a complete `Surface`; they do
 * not infer routing from chat-ID sign, topic-ID absence, or separate flags.
 */

import type { Context } from "grammy";
import {
  dmSurface,
  guestSurface,
  topicSurface,
  supergroupSurface,
  type Surface,
} from "../surface.ts";

function trySurface<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Normalize a grammy message/update context to a complete `Surface`.
 *
 * Returns `null` when the update has no supported chat, an unsupported chat
 * type, or invalid identifiers. This is the only place that inspects grammy
 * chat/update shape to decide surface kind.
 */
export function surfaceFromCtx(ctx: Context): Surface | null {
  const guest = ctx.guestMessage;
  if (guest?.chat?.id !== undefined) {
    return trySurface(() => guestSurface(guest.chat.id));
  }

  const chat = ctx.chat;
  if (!chat) return null;

  const chatId = chat.id;
  const msg = ctx.msg;

  const directMessagesTopic = msg?.direct_messages_topic;
  if (
    chat.type === "supergroup" &&
    chat.is_direct_messages === true &&
    directMessagesTopic &&
    typeof directMessagesTopic.topic_id === "number"
  ) {
    return trySurface(() =>
      topicSurface("direct-messages", chatId, directMessagesTopic.topic_id)
    );
  }

  // A direct_messages_topic on a non-direct-messages chat is malformed.
  if (directMessagesTopic && typeof directMessagesTopic.topic_id === "number") {
    return null;
  }

  const isForumSupergroup =
    chat.type === "supergroup" &&
    chat.is_direct_messages !== true &&
    (chat as { is_forum?: boolean }).is_forum === true;

  const isTopic =
    typeof msg?.message_thread_id === "number" &&
    (msg?.is_topic_message === true || isForumSupergroup);

  if (isTopic) {
    const topicId = msg!.message_thread_id!;
    if (chat.type === "private") {
      return trySurface(() => topicSurface("private", chatId, topicId));
    }
    if (chat.type === "supergroup") {
      if (chat.is_direct_messages === true) return null;
      if (isForumSupergroup && msg?.is_topic_message !== true) {
        if (topicId === 1) {
          return trySurface(() => topicSurface("supergroup", chatId, topicId));
        }
        return null;
      }
      return trySurface(() => topicSurface("supergroup", chatId, topicId));
    }
    return null;
  }

  if (chat.type === "private") {
    return trySurface(() => dmSurface(chatId));
  }

  if (chat.type === "supergroup") {
    if (chat.is_direct_messages === true) return null;
    return trySurface(() => supergroupSurface(chatId));
  }

  return null;
}
