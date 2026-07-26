import type { Context } from "grammy";
import type { SessionManager } from "../sessions/mod.ts";
import { surfaceFromCtx } from "../tg/context-surface.ts";
import { deliveryOpts } from "../tg/delivery.ts";
import { systemReply } from "../tg/format.ts";

const BASE_REPLY_OPTS: Record<string, unknown> = { parse_mode: "MarkdownV2", disable_notification: true };

/**
 * /start command handler.
 * - In a private chat (DM): creates a new session and welcomes the user.
 * - In a topic: informs that topics are already their own session.
 * - In a non-forum group: rejected — groups have no session isolation, use topics.
 */
export function buildStartHandler(manager: SessionManager) {
  return async (ctx: Context): Promise<void> => {
    const chatType = ctx.chat?.type;

    // Reject plain groups before attempting to build a Surface.
    if (chatType === "group") {
      await ctx.reply(
        systemReply("Use /start in a private chat or a forum topic.", "info"),
        BASE_REPLY_OPTS,
      );
      return;
    }

    const surface = surfaceFromCtx(ctx);
    if (!surface) {
      await ctx.reply(
        systemReply("Unable to determine chat context.", "error"),
        BASE_REPLY_OPTS,
      );
      return;
    }

    const replyOpts = deliveryOpts(surface, BASE_REPLY_OPTS);

    // Reject non-private, non-topic, non-supergroup chats.
    // Check for message_thread_id to handle forum General topics (is_topic_message=false but still a forum)
    const hasThreadId = ctx.msg && "message_thread_id" in ctx.msg && typeof ctx.msg.message_thread_id === "number";
    const isSupergroup = chatType === "supergroup";
    if (chatType !== "private" && surface.kind !== "topic" && !hasThreadId && !isSupergroup) {
      await ctx.reply(
        systemReply("Use /start in a private chat or a forum topic.", "info"),
        replyOpts,
      );
      return;
    }

    if (surface.kind === "topic" || hasThreadId) {
      // In a forum topic (including General) - already has a session (auto-created on first message)
      await ctx.reply(
        systemReply("This topic is already its own session. Just start typing!", "info"),
        replyOpts,
      );
      return;
    }

    // Private chat (DM): reuse existing session if any, else create one.
    // /start is idempotent — use /new to force a fresh session.
    const existing = manager.resolve(surface);
    if (existing) {
      await ctx.reply(
        systemReply(`Welcome back. Session \`${existing.id}\` is active. Use /new for a fresh one.`, "info"),
        replyOpts,
      );
      return;
    }

    let state;
    try {
      state = manager.createForSurface(surface);
    } catch (e) {
      await ctx.reply(
        systemReply("Failed to create session. Please try again.", "error"),
        replyOpts,
      );
      throw e;
    }
    await ctx.reply(
      systemReply(`Session \`${state.id}\` ready. Just start typing!`, "info"),
      replyOpts,
    );
  };
}
