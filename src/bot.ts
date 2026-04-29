import { existsSync } from "node:fs";
import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware, locatorFromCtx, MessageBuffer } from "./tg/mod.ts";
import { registerCommands } from "./commands/mod.ts";
import { SessionManager } from "./sessions/mod.ts";
import { sessionDir } from "./sessions/paths.ts";
import { AgentRunner } from "./agent/mod.ts";
import { SubagentRunner, type SubagentToolFactory } from "./subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "./subagents/tool.ts";
import { interruptAndCascade } from "./interrupt.ts";
import { cancelReply } from "./commands/cancel.ts";
import { executeNew } from "./commands/new.ts";
import { executeArchive } from "./commands/archive.ts";
import { parseSubagentId, SUBAGENT_STUB_REPLY } from "./commands/subagents.ts";
import { HELP_REPLY } from "./commands/help.ts";
import { generateDiagnostics } from "./diagnostics.ts";

/** Slash-commands that trigger an interrupt + cascade-cancel before executing. */
const CANCEL_CAPABLE_COMMANDS = new Set(["/cancel", "/new", "/archive", "/debug"]);

/**
 * Tool factory that equips spawned subagents with spawn_subagent
 * and revive_subagent, enabling recursive spawning up to the depth cap.
 */
const subagentToolFactory: SubagentToolFactory = (
  runner,
  depth,
  sessionId,
  onStatusUpdate,
) => [
  createSpawnSubagentTool(runner, depth, sessionId, onStatusUpdate),
  createReviveSubagentTool(runner, onStatusUpdate),
];

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
export function buildBot(cfg: Config): { bot: Bot; manager: SessionManager; subagentRunner: SubagentRunner; agentRunners: Map<string, AgentRunner> } {
  const bot = new Bot(cfg.botToken);
  const manager = new SessionManager(cfg);
  const runners = new Map<string, AgentRunner>();
  const subagentRunner = new SubagentRunner(cfg, subagentToolFactory);

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

    // Resolve session (non-creating) early so command handlers can see
    // current runner state without forcing creation for slash-only flows.
    const isSupergroup = ctx.chat?.type === "supergroup";
    const session = manager.resolve(locator, { isSupergroup });
    const existingRunner = session ? runners.get(session.id) ?? null : null;

    // Command routing: known slash-commands handled here before normal
    // agent routing so they work even without an active session. Unknown
    // slash-commands fall through to normal agent routing.
    const rawText = ctx.msg?.text;
    if (rawText?.startsWith("/")) {
      const command = rawText.split(" ")[0] ?? "";

      // Capture pre-interrupt state so /cancel can report honestly:
      // the cascade about to run will reset both signals to "nothing live".
      const wasStreaming = existingRunner?.isStreaming ?? false;
      const hadLiveSubagents = subagentRunner
        .list()
        .some((s) => s.status === "running");

      // Cancel-capable commands abort the active stream and cascade-cancel
      // every live subagent before executing their own logic.
      if (CANCEL_CAPABLE_COMMANDS.has(command)) {
        await interruptAndCascade(existingRunner, subagentRunner);
      }

      switch (command) {
        case "/cancel":
          await ctx.reply(
            cancelReply({
              hasSession: session !== null,
              wasStreaming,
              hadLiveSubagents,
            }),
          );
          return;
        case "/new": {
          const isSupergroupChat = ctx.chat?.type === "supergroup";
          const result = executeNew({
            hasTopic: locator.topicId !== undefined,
            createSession: () =>
              manager.createForChat(locator, { isSupergroup: isSupergroupChat }),
          });
          if (result.kind === "created") {
            runners.set(
              result.session.id,
              new AgentRunner({
                cfg,
                sessionId: result.session.id,
                customTools: [],
                subagentRunner,
              }),
            );
            log.debug("created runner for /new session", { sessionId: result.session.id });
          }
          await ctx.reply(result.reply);
          return;
        }
        case "/archive": {
          const archiveResult = executeArchive({
            hasSession: session !== null,
            sessionExists: session !== null && existsSync(sessionDir(cfg.goblinHome, session.id)),
            archive: () => {
              // session is guaranteed non-null in this branch (sessionExists implies hasSession)
              manager.archive(session!.id);
              runners.delete(session!.id);
            },
          });
          if (archiveResult.kind === "archived" && locator.topicId !== undefined && session) {
            try {
              await bot.api.editForumTopic(locator.chatId, locator.topicId, {
                name: `Archived: ${session.title ?? session.id}`,
              });
            } catch (err) {
              log.error("failed to rename topic on archive", {
                error: String(err),
                chatId: locator.chatId,
                topicId: locator.topicId,
              });
            }
          }
          await ctx.reply(archiveResult.reply);
          return;
        }
        case "/debug": {
          if (!session) {
            await ctx.reply("No active session.");
            return;
          }
          const diag = generateDiagnostics({
            session,
            runner: existingRunner,
            subagentRunner,
            goblinHome: cfg.goblinHome,
            modelName: cfg.modelName,
          });
          await ctx.reply(diag);
          return;
        }
        case "/subagents":
          await ctx.reply(SUBAGENT_STUB_REPLY);
          return;
        case "/cancel_subagent": {
          const id = parseSubagentId(rawText);
          log.debug("/cancel_subagent stub invoked", { id });
          await ctx.reply(SUBAGENT_STUB_REPLY);
          return;
        }
        case "/revive": {
          const id = parseSubagentId(rawText);
          log.debug("/revive stub invoked", { id });
          await ctx.reply(SUBAGENT_STUB_REPLY);
          return;
        }
        case "/help":
          await ctx.reply(HELP_REPLY);
          return;
        default:
          // Unknown /command — fall through to normal agent routing
          break;
      }
    }

    if (!session) {
      // DM without active session - prompt user to create one
      if (locator.topicId === undefined) {
        ctx.reply("No active session. Use /new to start one.").catch((err: unknown) => {
          log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
        });
      }
      log.debug("dropping message: no session", { chatId: locator.chatId, topicId: locator.topicId });
      return;
    }

    // Look up or lazily construct the runner for this session
    let runner = runners.get(session.id);
    if (!runner) {
      runner = new AgentRunner({ cfg, sessionId: session.id, customTools: [], subagentRunner });
      runners.set(session.id, runner);
      log.debug("created runner for session", { sessionId: session.id });
    }

    const text = ctx.msg?.text;
    if (!text) return;

    // MessageBuffer turns agent events into Telegram UI (status line + streamed
    // response). One buffer per turn so message IDs are scoped to this prompt.
    const buffer = new MessageBuffer(bot, locator.chatId, locator.topicId, {
      visibility: cfg.toolVisibility,
    });

    try {
      await runner.prompt(text, buffer);
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

  return { bot, manager, subagentRunner, agentRunners: runners };
}
