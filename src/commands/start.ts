import type { Context } from "grammy";
import type { SessionManager } from "../sessions/mod.ts";
import { locatorFromCtx } from "../tg/locator.ts";

/**
 * /start command handler.
 * - In a private chat (DM): creates a new session and welcomes the user.
 * - In a topic: informs that topics are already their own session.
 * - In a non-forum group: rejected — groups have no session isolation, use topics.
 */
export function buildStartHandler(manager: SessionManager) {
  return async (ctx: Context): Promise<void> => {
    const loc = locatorFromCtx(ctx);
    if (!loc) {
      await ctx.reply("Unable to determine chat context.");
      return;
    }

    // Thread into which we reply (may be "General" topic even when loc.topicId is undefined)
    const replyThreadId =
      ctx.msg && "message_thread_id" in ctx.msg ? ctx.msg.message_thread_id : undefined;
    const replyOpts = replyThreadId !== undefined ? { message_thread_id: replyThreadId } : {};

    // Reject non-private, non-topic chats (plain groups have no session isolation)
    // Check for message_thread_id to handle forum General topics (is_topic_message=false but still a forum)
    const chatType = ctx.chat?.type;
    const hasThreadId = ctx.msg && "message_thread_id" in ctx.msg && typeof ctx.msg.message_thread_id === "number";
    if (chatType !== "private" && loc.topicId === undefined && !hasThreadId) {
      await ctx.reply("Use /start in a private chat or a forum topic.", replyOpts);
      return;
    }

    if (loc.topicId !== undefined || hasThreadId) {
      // In a forum topic (including General) - already has a session (auto-created on first message)
      await ctx.reply("This topic is already its own session. Just start typing!", replyOpts);
      return;
    }

    // Private chat (DM): create a new session
    let state;
    try {
      state = manager.createForChat(loc);
    } catch (e) {
      await ctx.reply("Failed to create session. Please try again.");
      throw e;
    }
    await ctx.reply(
      `Session \`${state.id}\` ready\\. Just start typing\\!`,
      { parse_mode: "MarkdownV2", ...replyOpts },
    );
  };
}
