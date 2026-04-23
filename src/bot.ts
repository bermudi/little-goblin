import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware, locatorFromCtx } from "./tg/mod.ts";
import { registerCommands } from "./commands/mod.ts";
import { SessionManager } from "./sessions/mod.ts";
import { AgentRunner, type TurnCallbacks } from "./agent/mod.ts";

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
export function buildBot(cfg: Config): { bot: Bot; manager: SessionManager } {
  const bot = new Bot(cfg.botToken);
  const manager = new SessionManager(cfg);
  const runners = new Map<string, AgentRunner>();

  // Security layer: drop messages from non-allowed users
  bot.use(buildAllowlistMiddleware(cfg));

  // Command handlers
  registerCommands(bot, manager);

  // Wire agent runner for text messages
  bot.on("message:text", async (ctx: Context) => {
    const locator = locatorFromCtx(ctx);
    if (!locator) {
      log.debug("dropping message: no locator");
      return;
    }

    const session = manager.resolve(locator);
    if (!session) {
      // DM without active session - silently drop (user needs /new)
      log.debug("dropping message: no session", { chatId: locator.chatId, topicId: locator.topicId });
      return;
    }

    // Look up or lazily construct the runner for this session
    let runner = runners.get(session.id);
    if (!runner) {
      runner = new AgentRunner(cfg, session.id, []);
      runners.set(session.id, runner);
      log.debug("created runner for session", { sessionId: session.id });
    }

    // Build minimal TurnCallbacks
    const accumulated: string[] = [];
    const callbacks: TurnCallbacks = {
      onTextDelta: (text: string) => {
        accumulated.push(text);
      },
      onToolStart: (name: string, input: unknown) => {
        log.debug("tool start", { name, input });
      },
      onToolEnd: (name: string, result: unknown) => {
        log.debug("tool end", { name, result });
      },
      onStatusUpdate: (message: string) => {
        log.debug("status update", { message });
      },
      onAgentEnd: () => {
        const text = accumulated.join("");
        if (text) {
          ctx.reply(text).catch((err: unknown) => {
            log.error("failed to send reply", { error: String(err), sessionId: session.id });
          });
        }
      },
    };

    const text = ctx.msg?.text;
    if (!text) return;

    try {
      await runner.prompt(text, callbacks);
    } catch (err) {
      log.error("runner prompt failed", { error: String(err), sessionId: session.id });
    }
  });

  bot.catch((err) => {
    log.error("bot error", {
      name: err.error instanceof Error ? err.error.name : typeof err.error,
      message: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  return { bot, manager };
}
