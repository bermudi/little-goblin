import type { Bot } from "grammy";
import { pingHandler } from "./ping.ts";

/**
 * Register all command handlers on the bot.
 * This is the single place to wire up commands.
 */
export function registerCommands(bot: Bot): void {
  bot.command("ping", pingHandler);
}
