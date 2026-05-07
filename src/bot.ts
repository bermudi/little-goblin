import { existsSync } from "node:fs";
import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware, locatorFromCtx, MessageBuffer } from "./tg/mod.ts";
import {
  createSendVoiceTool,
  createSendPhotoTool,
  createSendDocumentTool,
  createReactTool,
  createRenameTopicTool,
  createChatActionTool,
} from "./tg/tools.ts";
import { MemoryStore } from "./memory/mod.ts";
import { registerCommands } from "./commands/mod.ts";
import { SessionManager } from "./sessions/mod.ts";
import { sessionDir } from "./sessions/paths.ts";
import { AgentRunner } from "./agent/mod.ts";
import { SubagentRunner, type SubagentToolFactory } from "./subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "./subagents/tool.ts";
import { interruptAndCascade, DEFAULT_CASCADE_TIMEOUT_MS, type CascadeResult } from "./interrupt.ts";
import { cancelReply, formatCascadeTimeoutSuffix } from "./commands/cancel.ts";
import { executeNew } from "./commands/new.ts";
import { executeArchive } from "./commands/archive.ts";
import { executeProject } from "./commands/project.ts";
import { parseCommand } from "./commands/parse.ts";
import { parseSubagentId, SUBAGENT_STUB_REPLY } from "./commands/subagents.ts";
import { HELP_REPLY } from "./commands/help.ts";
import { generateDiagnostics } from "./diagnostics.ts";

/** Slash-commands that trigger an interrupt + cascade-cancel before executing. */
const CANCEL_CAPABLE_COMMANDS = new Set(["/cancel", "/new", "/archive", "/project", "/debug"]);

/**
 * Tool factory that equips spawned subagents with spawn_subagent
 * and revive_subagent, enabling recursive spawning up to the depth cap.
 */
const subagentToolFactory: SubagentToolFactory = (
  runner,
  depth,
  sessionId,
  activeScope,
  onStatusUpdate,
) => [
  createSpawnSubagentTool(runner, depth, sessionId, activeScope, onStatusUpdate, undefined),
  createReviveSubagentTool(runner, onStatusUpdate),
];

async function getTopicName(bot: Bot, chatId: number, topicId: number): Promise<string | null> {
  const api = bot.api as unknown as {
    getForumTopic?: (chatId: number, messageThreadId: number) => Promise<{ name?: unknown }>;
  };
  if (api.getForumTopic === undefined) return null;
  try {
    const topic = await api.getForumTopic(chatId, topicId);
    return typeof topic.name === "string" ? topic.name : null;
  } catch {
    return null;
  }
}

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
    const command = parseCommand(rawText);
    if (command !== null) {

      // Cancel-capable commands abort the active stream and cascade-cancel
      // every live subagent before executing their own logic. The cascade
      // returns a summary so /cancel can report honestly (including any
      // timeouts) instead of relying on a stale pre-interrupt snapshot.
      let cascade: CascadeResult | null = null;
      if (CANCEL_CAPABLE_COMMANDS.has(command)) {
        cascade = await interruptAndCascade(
          existingRunner,
          subagentRunner,
          DEFAULT_CASCADE_TIMEOUT_MS,
          session?.id ?? null,
        );
      }

      switch (command) {
        case "/cancel":
          // S10: If user has no session (session === null), cascade targets
          // ALL running subagents process-wide (legacy mode). This is by design:
          // "cancel" means "stop everything" in the user's mental model.
          await ctx.reply(
            cancelReply({
              hasSession: session !== null,
              cascade: cascade ?? {
                attemptedMain: false,
                attemptedSubagents: 0,
                timedOutMain: false,
                timedOutSubagents: 0,
              },
              cascadeTimeoutMs: DEFAULT_CASCADE_TIMEOUT_MS,
            }),
          );
          return;
        case "/new": {
          const isSupergroupChat = ctx.chat?.type === "supergroup";
          // /new is a universal "reset this chat surface" command:
          // archive the prior session (if one exists and is not already
          // archived), then create a fresh session bound to the same
          // (chat, topic) / supergroup / DM slot. Topic title is NOT
          // renamed — that's /archive's job, not /new's.
          const priorSession = session;
          const priorSessionExists =
            priorSession !== null && existsSync(sessionDir(cfg.goblinHome, priorSession.id));
          let result;
          try {
            result = executeNew({
              archivePrior: priorSessionExists
                ? () => {
                    // Archive first; if rename fails, the old runner
                    // stays alive on the original dir and the user can
                    // retry. Only dispose after a successful move.
                    manager.archive(priorSession!.id);
                    const prior = runners.get(priorSession!.id);
                    if (prior) prior.dispose();
                    runners.delete(priorSession!.id);
                  }
                : undefined,
              createSession: () =>
                manager.createForChat(locator, { isSupergroup: isSupergroupChat }),
            });
          } catch (err) {
            // S9: Partial failure — archive succeeded but create failed (e.g., disk full).
            // No rollback: the old session is in archive/, user has no active session.
            // Rare failure mode; retry with /new is the natural recovery.
            log.error("archive-on-new failed", {
              error: String(err),
              sessionId: priorSession?.id,
            });
            await ctx.reply("Failed to reset session. Please try again.");
            return;
          }
          // Edge case: prior binding was stale (state.json existed but
          // session dir was missing). Clear the dangling runner entry so
          // it doesn't outlive its now-orphaned session.
          if (priorSession && !priorSessionExists) {
            const orphan = runners.get(priorSession.id);
            if (orphan) {
              orphan.dispose();
              runners.delete(priorSession.id);
            }
          }
          const chatId = locator.chatId;
          const topicId = ctx.message?.message_thread_id;
          const messageId = ctx.message?.message_id;
          const betaTools = [
            createSendVoiceTool(bot, chatId),
            createSendPhotoTool(bot, chatId),
            createSendDocumentTool(bot, chatId),
            createReactTool(bot, chatId, messageId),
            createRenameTopicTool(bot, chatId, topicId),
            createChatActionTool(bot, chatId),
          ].filter((t): t is NonNullable<typeof t> => t !== null);
          runners.set(
            result.session.id,
            new AgentRunner({
              cfg,
              sessionId: result.session.id,
              locator,
              customTools: betaTools,
              subagentRunner,
              getTopicName: (cId, tId) => getTopicName(bot, cId, tId),
              projectDir: result.session.projectDir,
            }),
          );
          log.debug("created runner for /new session", {
            sessionId: result.session.id,
            archivedPrior: result.archivedPrior,
          });
          // Surface cascade timeouts honestly — the new session is ready
          // but the user should know if the old stream/subagents stalled.
          const suffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${result.reply}${suffix}`);
          return;
        }
        case "/archive": {
          let archiveResult;
          try {
            archiveResult = executeArchive({
              hasSession: session !== null,
              sessionExists: session !== null && existsSync(sessionDir(cfg.goblinHome, session.id)),
              archive: () => {
                // session is guaranteed non-null in this branch (sessionExists implies hasSession)
                manager.archive(session!.id);
                // Dispose the runner so its pi AgentSession releases its
                // subscription before we drop the map entry.
                const prior = runners.get(session!.id);
                if (prior) prior.dispose();
                runners.delete(session!.id);
              },
            });
          } catch (err) {
            log.error("archive failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to archive session. Please try again.");
            return;
          }
          // Topic UI is user-owned (decision 0002 topic-ui-is-user-owned):
          // /archive moves the session and clears the binding. It MUST NOT
          // rename, close, or otherwise mutate the topic surface. The next
          // user message in this topic will auto-create a fresh session.
          const archiveSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${archiveResult.reply}${archiveSuffix}`);
          return;
        }
        case "/project": {
          let projectResult;
          try {
            projectResult = executeProject({
              hasSession: session !== null,
              rawText: rawText ?? "",
              setProjectDir: (dir) => {
                if (!session) return;
                manager.setProjectDir(session.id, dir);
                // Dispose the runner so next message recreates it with the new directory.
                const prior = runners.get(session.id);
                if (prior) {
                  prior.dispose();
                  runners.delete(session.id);
                }
              },
            });
          } catch (err) {
            log.error("project failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to set project directory. Please try again.");
            return;
          }
          const projectSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${projectResult.reply}${projectSuffix}`);
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
          const debugSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${diag}${debugSuffix}`);
          return;
        }
        case "/subagents":
          await ctx.reply(SUBAGENT_STUB_REPLY);
          return;
        case "/cancel_subagent": {
          const id = parseSubagentId(rawText ?? "");
          log.debug("/cancel_subagent stub invoked", { id });
          await ctx.reply(SUBAGENT_STUB_REPLY);
          return;
        }
        case "/revive": {
          const id = parseSubagentId(rawText ?? "");
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
      const chatId = locator.chatId;
      const topicId = ctx.message?.message_thread_id;
      const messageId = ctx.message?.message_id;
      const betaTools = [
        createSendVoiceTool(bot, chatId),
        createSendPhotoTool(bot, chatId),
        createSendDocumentTool(bot, chatId),
        createReactTool(bot, chatId, messageId),
        createRenameTopicTool(bot, chatId, topicId),
        createChatActionTool(bot, chatId),
      ].filter((t): t is NonNullable<typeof t> => t !== null);
      runner = new AgentRunner({
        cfg,
        sessionId: session.id,
        locator,
        customTools: betaTools,
        subagentRunner,
        getTopicName: (cId, tId) => getTopicName(bot, cId, tId),
        projectDir: session.projectDir,
      });
      runners.set(session.id, runner);
      log.debug("created runner for session", { sessionId: session.id });
    }

    const text = ctx.msg?.text;
    if (!text) return;

    // MessageBuffer turns agent events into Telegram UI (status line + streamed
    // response). One buffer per turn so message IDs are scoped to this prompt.
    // Wire up orphan archival: if Telegram reports "topic not found", archive
    // the orphaned memory scope before propagating the error.
    const memoryStore = new MemoryStore(cfg.goblinHome);
    const topicId = locator.topicId;
    const buffer = new MessageBuffer(bot, locator.chatId, topicId, {
      visibility: cfg.toolVisibility,
      onTopicNotFound:
        topicId !== undefined
          ? async () => {
              await memoryStore.archiveOrphan(locator.chatId, topicId);
            }
          : undefined,
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
