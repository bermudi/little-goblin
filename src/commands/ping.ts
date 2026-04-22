import type { Context } from "grammy";

/**
 * Smoke-test command. Returns pong with user and chat info.
 */
export async function pingHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const topicId = ctx.msg && "message_thread_id" in ctx.msg ? ctx.msg.message_thread_id : undefined;
  await ctx.reply(
    `pong 🐲\nuser: ${userId}\nchat: ${chatType}${topicId ? `\ntopic: ${topicId}` : ""}`,
    topicId !== undefined ? { message_thread_id: topicId } : {},
  );
}
