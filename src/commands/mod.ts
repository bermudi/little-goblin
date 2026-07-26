import type { Bot } from "grammy";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { COMMAND_REGISTRY } from "./registry.ts";

/**
 * Register grammy command handlers on the bot.
 *
 * Iterates `COMMAND_REGISTRY` for defs with a `grammyHandler` and registers
 * each via `bot.command(name, grammyHandler({ lifecycle }))`.
 * Session-affecting commands (defs with a `handler`) are dispatched from `bot.ts`'s
 * `message:text` handler via `handleCommand()` so they share interrupt
 * semantics and can run even without a bound session.
 */
export function registerCommands(
  bot: Bot,
  lifecycle: ConversationLifecycle,
): void {
  for (const def of COMMAND_REGISTRY) {
    if (def.grammyHandler) {
      bot.command(def.name, def.grammyHandler({ lifecycle }));
    }
  }
}
