import { Bot, type Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware } from "./tg/mod.ts";
import { registerCommands } from "./commands/mod.ts";

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
export function buildBot(cfg: Config): Bot {
  const bot = new Bot(cfg.botToken);

  // Security layer: drop messages from non-allowed users
  bot.use(buildAllowlistMiddleware(cfg));

  // Command handlers
  registerCommands(bot);

  // Fallback: echo all other text until the agent runner is wired
  bot.on("message:text", async (ctx: Context) => {
    const topicId = ctx.msg && "message_thread_id" in ctx.msg ? ctx.msg.message_thread_id : undefined;
    log.info("message received", {
      chatId: ctx.chat!.id,
      topicId,
      text: ctx.msg!.text!.slice(0, 80),
    });
    await ctx.reply(
      `🐲 I hear you, but my brain isn't wired yet. Soon.`,
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
