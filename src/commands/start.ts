import type { Context } from "grammy";
import type { SessionManager } from "../sessions/mod.ts";
import { locatorFromCtx } from "../tg/locator.ts";
import { systemReply } from "../tg/format.ts";

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
      await ctx.reply(
        systemReply("Unable to determine chat context.", "error"),
        { parse_mode: "MarkdownV2", disable_notification: true },
      );
      return;
    }

    // Thread into which we reply (may be "General" topic even when loc.topicId is undefined)
    const replyThreadId =
      ctx.msg && "message_thread_id" in ctx.msg ? ctx.msg.message_thread_id : undefined;
    const replyOpts = replyThreadId !== undefined ? { message_thread_id: replyThreadId } : {};

    // Reject non-private, non-topic, non-supergroup chats (plain groups have no session isolation)
    // Check for message_thread_id to handle forum General topics (is_topic_message=false but still a forum)
    const chatType = ctx.chat?.type;
    const hasThreadId = ctx.msg && "message_thread_id" in ctx.msg && typeof ctx.msg.message_thread_id === "number";
    const isSupergroup = chatType === "supergroup";
    if (chatType !== "private" && loc.topicId === undefined && !hasThreadId && !isSupergroup) {
      await ctx.reply(
        systemReply("Use /start in a private chat or a forum topic.", "info"),
        { parse_mode: "MarkdownV2", disable_notification: true, ...replyOpts },
      );
      return;
    }

    if (loc.topicId !== undefined || hasThreadId) {
      // In a forum topic (including General) - already has a session (auto-created on first message)
      await ctx.reply(
        systemReply("This topic is already its own session. Just start typing!", "info"),
        { parse_mode: "MarkdownV2", disable_notification: true, ...replyOpts },
      );
      return;
    }

    // Private chat (DM): reuse existing session if any, else create one.
    // /start is idempotent — use /new to force a fresh session.
    const existing = manager.resolve(loc, { isSupergroup });
    if (existing) {
      await ctx.reply(
        systemReply(`Welcome back. Session \`${existing.id}\` is active. Use /new for a fresh one.`, "info"),
        { parse_mode: "MarkdownV2", disable_notification: true, ...replyOpts },
      );
      return;
    }

    let state;
    try {
      state = manager.createForChat(loc, { isSupergroup });
    } catch (e) {
      await ctx.reply(
        systemReply("Failed to create session. Please try again.", "error"),
        { parse_mode: "MarkdownV2", disable_notification: true, ...replyOpts },
      );
      throw e;
    }
    await ctx.reply(
      systemReply(`Session \`${state.id}\` ready. Just start typing!`, "info"),
      { parse_mode: "MarkdownV2", disable_notification: true, ...replyOpts },
    );
  };
}
