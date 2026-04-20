import { Bot, type Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

/**
 * Build the grammy Bot with allowlist middleware wired up.
 * Exported so main can attach handlers/commands incrementally.
 */
export function buildBot(cfg: Config): Bot {
  const bot = new Bot(cfg.botToken);

  // Allowlist middleware. Anything from a non-allowed user is silently dropped.
  // This is intentionally silent: we don't want to confirm the bot's existence
  // to strangers who poke at it.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !cfg.allowedTgUserIds.has(userId)) {
      log.debug("dropping message from non-allowed user", {
        userId,
        username: ctx.from?.username,
        chatId: ctx.chat?.id,
      });
      return;
    }
    await next();
  });

  // Smoke-test command. Will be removed / replaced once the agent runner is wired.
  bot.command("ping", async (ctx: Context) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    const topicId = ctx.msg && "message_thread_id" in ctx.msg ? ctx.msg.message_thread_id : undefined;
    await ctx.reply(
      `pong 🐲\nuser: ${userId}\nchat: ${chatType}${topicId ? `\ntopic: ${topicId}` : ""}`,
      topicId !== undefined ? { message_thread_id: topicId } : {},
    );
  });

  bot.catch((err) => {
    log.error("bot error", {
      name: err.error instanceof Error ? err.error.name : typeof err.error,
      message: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  return bot;
}
