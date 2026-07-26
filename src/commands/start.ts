import type { Context } from "grammy";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { surfaceFromCtx } from "../tg/context-surface.ts";
import { deliveryOpts } from "../tg/delivery.ts";
import { systemReply } from "../tg/format.ts";

const BASE_REPLY_OPTS: Record<string, unknown> = { parse_mode: "MarkdownV2", disable_notification: true };

/**
 * /start command handler.
 * - In a private chat (DM): reports the active conversation if one is bound,
 *   otherwise explains how to start one.
 * - In a forum topic (including General): inspects the topic binding and reports
 *   the active conversation or explains how to start one.
 * - In a non-forum group or channel: rejected — unsupported surface kinds.
 *
 * /start never creates or rotates a conversation; it only inspects the current
 * binding. This keeps it a pure welcome/status command on every surface.
 */
export function buildStartHandler(lifecycle: ConversationLifecycle) {
  return async (ctx: Context): Promise<void> => {
    const surface = surfaceFromCtx(ctx);
    if (!surface) {
      await ctx.reply(
        systemReply("Use /start in a private chat or a forum topic.", "info"),
        BASE_REPLY_OPTS,
      );
      return;
    }

    const replyOpts = deliveryOpts(surface, BASE_REPLY_OPTS);
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
