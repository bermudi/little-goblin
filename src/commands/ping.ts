import type { Context } from "grammy";
import { surfaceFromCtx } from "../tg/context-surface.ts";
import { deliveryOpts } from "../tg/delivery.ts";
import { systemReply } from "../tg/format.ts";

/**
 * Smoke-test command. Returns pong with user and chat info.
 */
export async function pingHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const surface = surfaceFromCtx(ctx);
  const topicId = surface?.kind === "topic" ? surface.topicId : undefined;
  const text = `pong 🐲\nuser: ${userId}\nchat: ${chatType}${topicId ? `\ntopic: ${topicId}` : ""}`;
  const baseOpts: Record<string, unknown> = { parse_mode: "MarkdownV2", disable_notification: true };
  const replyOpts: Record<string, unknown> = surface ? deliveryOpts(surface, baseOpts) : baseOpts;
  await ctx.reply(systemReply(text, "info"), replyOpts);
}
