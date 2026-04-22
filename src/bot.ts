import { Bot } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware } from "./tg/mod.ts";
import { registerCommands } from "./commands/mod.ts";
import { SessionManager } from "./sessions/mod.ts";

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
export function buildBot(cfg: Config): { bot: Bot; manager: SessionManager } {
  const bot = new Bot(cfg.botToken);
  const manager = new SessionManager(cfg);

  // Security layer: drop messages from non-allowed users
  bot.use(buildAllowlistMiddleware(cfg));

  // Command handlers
  registerCommands(bot, manager);

  // TODO: Wire agent runner here. Until then, messages are silently dropped
  // to avoid shipping a confusing echo-scaffold as "fallback" behavior.
  // bot.on("message:text", agentRunner.handler);

  bot.catch((err) => {
    log.error("bot error", {
      name: err.error instanceof Error ? err.error.name : typeof err.error,
      message: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  return { bot, manager };
}
