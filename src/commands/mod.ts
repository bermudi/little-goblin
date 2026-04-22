import type { Bot } from "grammy";
import type { SessionManager } from "../sessions/mod.ts";
import { pingHandler } from "./ping.ts";
import { buildNewHandler } from "./new.ts";

/**
 * Register all command handlers on the bot.
 * This is the single place to wire up commands.
 */
export function registerCommands(bot: Bot, manager: SessionManager): void {
  bot.command("ping", pingHandler);
  bot.command("new", buildNewHandler(manager));
}
