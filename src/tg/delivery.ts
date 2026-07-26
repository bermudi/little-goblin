import type { Surface } from "../surface.ts";

export interface TelegramSendTarget {
  chatId: number;
  opts: Record<string, unknown>;
}

function threadKey(surface: Extract<Surface, { kind: "topic" }>): string {
  return surface.container === "direct-messages" ? "direct_messages_topic_id" : "message_thread_id";
}

function assertNotGuest(surface: Surface): void {
  if (surface.kind === "guest") {
    throw new Error("Guest surfaces do not support normal Telegram send/edit methods; use answerGuestQuery");
  }
}

/**
 * Build Telegram API options for a non-guest Surface, adding the correct
 * topic parameter when present. For a forum General topic (`supergroup`
 * container, `topicId === 1`) the thread ID is intentionally omitted for
 * normal sends/edits/media/drafts, because Telegram routes those to the
 * General topic when no thread is supplied. Throws for guest surfaces.
 */
export function deliveryOpts(surface: Surface, extra: Record<string, unknown> = {}): Record<string, unknown> {
  assertNotGuest(surface);

  if (surface.kind !== "topic") {
    return extra;
  }

  if (surface.container === "supergroup" && surface.topicId === 1) {
    return extra;
  }

  return { ...extra, [threadKey(surface)]: surface.topicId };
}

/**
 * Build Telegram API options for `sendChatAction` and other typing-status
 * calls. Like `deliveryOpts`, but always includes the topic parameter for
 * topic surfaces, including `message_thread_id = 1` for a forum General
 * topic so the typing indicator appears there.
 */
export function chatActionDeliveryOpts(surface: Surface, extra: Record<string, unknown> = {}): Record<string, unknown> {
  assertNotGuest(surface);

  if (surface.kind !== "topic") {
    return extra;
  }

  return { ...extra, [threadKey(surface)]: surface.topicId };
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
