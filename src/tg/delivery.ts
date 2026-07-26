import type { Surface } from "../surface.ts";

export interface TelegramSendTarget {
  chatId: number;
  opts: Record<string, unknown>;
}

/**
 * Build Telegram API options for a non-guest Surface, adding the correct
 * topic parameter when present. Throws for guest surfaces because normal
 * chat send/edit methods cannot be used for guest summons; the one-shot
 * `answerGuestQuery` callback is the only supported delivery path.
 */
export function deliveryOpts(surface: Surface, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (surface.kind === "guest") {
    throw new Error("Guest surfaces do not support normal Telegram send/edit methods; use answerGuestQuery");
  }

  if (surface.kind !== "topic") {
    return extra;
  }

  const threadKey = surface.container === "direct-messages" ? "direct_messages_topic_id" : "message_thread_id";
  return { ...extra, [threadKey]: surface.topicId };
}

/**
 * Resolve a Surface to the Telegram `chat_id` plus API options. Throws for
 * guest surfaces for the same reason as `deliveryOpts`.
 */
export function sendTarget(surface: Surface): TelegramSendTarget {
  return { chatId: surface.chatId, opts: deliveryOpts(surface) };
}

/**
 * True for surfaces whose delivery lane behaves like a private chat and
 * therefore supports private-chat draft mode. This is `dm` and private-chat
 * topics; supergroups and direct-messages topics are not private chats.
 */
export function isPrivateChat(surface: Surface): boolean {
  return surface.kind === "dm" || (surface.kind === "topic" && surface.container === "private");
}
