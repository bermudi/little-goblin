import type { Context } from "grammy";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { surfaceFromCtx } from "../tg/context-surface.ts";
import { deliveryOpts } from "../tg/delivery.ts";
import { systemReply } from "../tg/format.ts";
import { topicSurface, type TopicContainer } from "../surface.ts";

const BASE_REPLY_OPTS: Record<string, unknown> = { parse_mode: "MarkdownV2", disable_notification: true };

/**
 * /start command handler.
 * - In a private chat (DM): reports the active conversation if one is bound,
 *   otherwise explains how to start one.
 * - In a forum topic (including General): inspects the topic binding and reports
 *   the active conversation or explains how to start one.
 * - In a non-forum group: rejected — groups have no conversation isolation, use topics.
 *
 * /start never creates or rotates a conversation; it only inspects the current
 * binding. This keeps it a pure welcome/status command on every surface.
 */
export function buildStartHandler(lifecycle: ConversationLifecycle) {
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

    // Reject non-private, non-topic, non-supergroup chats.
    // Check for message_thread_id to handle forum General topics (is_topic_message=false but still a forum)
    const hasThreadId = ctx.msg && "message_thread_id" in ctx.msg && typeof ctx.msg.message_thread_id === "number";
    const isSupergroup = chatType === "supergroup";
    if (chatType !== "private" && surface.kind !== "topic" && !hasThreadId && !isSupergroup) {
      await ctx.reply(
        systemReply("Use /start in a private chat or a forum topic.", "info"),
        BASE_REPLY_OPTS,
      );
      return;
    }

    let inspectSurface = surface;
    if (surface.kind !== "topic" && hasThreadId && typeof ctx.msg?.message_thread_id === "number") {
      const container: TopicContainer = surface.kind === "supergroup" ? "supergroup" : "private";
      inspectSurface = topicSurface(container, surface.chatId, ctx.msg.message_thread_id);
    }

    const replyOpts = deliveryOpts(inspectSurface, BASE_REPLY_OPTS);

    if (surface.kind === "topic" || hasThreadId) {
      const conversation = lifecycle.inspect(inspectSurface);
      if (conversation) {
        await ctx.reply(
          systemReply(`Welcome back\. Conversation \`${conversation.id}\` is active\. Use /new for a fresh one.`, "info"),
          replyOpts,
        );
        return;
      }

      await ctx.reply(
        systemReply("No active conversation\. Send any message to start one, or use /new to create one explicitly.", "info"),
        replyOpts,
      );
      return;
    }

    // Private chat (DM): inspect the current binding without creating.
    const conversation = lifecycle.inspect(surface);
    if (conversation) {
      await ctx.reply(
        systemReply(`Welcome back\. Conversation \`${conversation.id}\` is active\. Use /new for a fresh one.`, "info"),
        replyOpts,
      );
      return;
    }

    await ctx.reply(
      systemReply("No active conversation\. Send any message to start one, or use /new to create one explicitly.", "info"),
      replyOpts,
    );
  };
}
