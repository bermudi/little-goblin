import type { Context, NextFunction } from "grammy";
import type { Config } from "../config.ts";
import { log } from "../log.ts";

/**
 * Build allowlist middleware. Anything from a non-allowed user is silently dropped.
 * This is intentionally silent: we don't want to confirm the bot's existence
 * to strangers who poke at it.
 */
export function buildAllowlistMiddleware(cfg: Config) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
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
  };
}
