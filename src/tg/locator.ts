import type { Context } from "grammy";
import type { ChatLocator } from "../sessions/mod.ts";

/**
 * Derive a ChatLocator from a grammy context.
 * Returns null if the context doesn't have a valid chat.
 *
 * Topic detection:
 * - `is_topic_message` in msg indicates a real forum topic (not "General").
 * - `message_thread_id` may exist for "General" topics, but we treat those as DM-style.
 */
export function locatorFromCtx(ctx: Context): ChatLocator | null {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return null;

  const msg = ctx.msg;
  const isTopic =
    msg &&
    "is_topic_message" in msg &&
    msg.is_topic_message === true &&
    "message_thread_id" in msg &&
    typeof msg.message_thread_id === "number";

  const topicId = isTopic ? (msg as { message_thread_id: number }).message_thread_id : undefined;
  const isPrivate = ctx.chat?.type === "private";

  return { chatId, topicId, isPrivate };
}
