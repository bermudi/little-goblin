import type { Bot } from "grammy";
import type { SessionManager } from "../sessions/mod.ts";
import { pingHandler } from "./ping.ts";
import { buildStartHandler } from "./start.ts";

/**
 * Register all command handlers on the bot.
 *
 * `/new` and other session-affecting commands are handled in `bot.ts`'s
 * `message:text` handler so they share interrupt semantics and bypass
 * grammy's `bot.command()` middleware (which would consume them first).
 * Only commands with no interrupt semantics live here.
 */
export function registerCommands(bot: Bot, manager: SessionManager): void {
  bot.command("ping", pingHandler);
  bot.command("start", buildStartHandler(manager));
}
