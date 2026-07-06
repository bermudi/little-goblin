import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware, locatorFromCtx } from "./tg/mod.ts";
import { prepareUserContent } from "./tg/user-context.ts";
import { MemoryStore } from "./memory/mod.ts";
import { registerCommands } from "./commands/mod.ts";
import { SessionManager, type ChatLocator } from "./sessions/mod.ts";
import { AgentRunner } from "./agent/mod.ts";
import { SubagentRunner, type SubagentToolFactory } from "./subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "./subagents/tool.ts";
import { configureVoice } from "./voice.ts";
import { ScheduleStore } from "./scheduler/store.ts";
import {
  createTelegramIntake,
  replyNoActiveSession as replyNoActiveSessionForMessage,
  type PromptContent,
  type TelegramIntakeMessage,
} from "./tg/intake.ts";
import type { TurnDispatcher } from "./tg/turn-dispatcher.ts";

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

function intakeMessageFromCtx(ctx: Context): TelegramIntakeMessage {
  return {
    locator: locatorFromCtx(ctx),
    isSupergroup: ctx.chat?.type === "supergroup",
    threadId: ctx.message?.message_thread_id,
    reply: async (text) => {
      await ctx.reply(text);
    },
    prepare: (content: PromptContent): PromptContent => {
      if (typeof content === "string") return prepareUserContent(ctx, content);
      return prepareUserContent(ctx, content);
    },
  };
}

/**
 * Reply to the user that they need an active session, and log the drop.
 * Only pings the user in DMs — in topics, we silently drop to avoid
 * spamming every topic in a forum with the same prompt. Always logs.
 */
export function replyNoActiveSession(ctx: Context, locator: ChatLocator, kind: string): void {
  replyNoActiveSessionForMessage({
    locator,
    isSupergroup: ctx.chat?.type === "supergroup",
    threadId: ctx.message?.message_thread_id,
    reply: async (text) => {
      await ctx.reply(text);
    },
    prepare: (content) => content,
  }, locator, kind);
}

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
interface BuildBotOptions {
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
}

export function buildBot(cfg: Config, options: BuildBotOptions = {}): { bot: Bot; manager: SessionManager; subagentRunner: SubagentRunner; agentRunners: Map<string, AgentRunner>; scheduleStore: ScheduleStore; dispatcher: TurnDispatcher } {
  configureVoice(cfg);
  const bot = new Bot(cfg.botToken);
  const manager = new SessionManager(cfg);
  const runners = new Map<string, AgentRunner>();
  const subagentRunner = new SubagentRunner(cfg, subagentToolFactory);
  const memoryStore = new MemoryStore(cfg.goblinHome);
  // One shared schedule store: `/schedule` mutates it from the command path,
  // and the scheduler loop reads/claims from it. Constructed here so both
  // intake and the loop (wired in index.ts) share a single instance.
  const scheduleStore = new ScheduleStore(cfg.goblinHome);
  const intake = createTelegramIntake({
    cfg,
    bot,
    manager,
    subagentRunner,
    memoryStore,
    agentRunners: runners,
    createAgentRunner: options.createAgentRunner,
    scheduleStore,
  });

  bot.use(buildAllowlistMiddleware(cfg));
  registerCommands(bot, manager);

  bot.on("message:text", async (ctx: Context) => {
    await intake.handleText(intakeMessageFromCtx(ctx), ctx.msg?.text);
  });

  bot.on("message:photo", async (ctx: Context) => {
    const fileIds = ctx.msg?.photo?.map((photo) => photo.file_id) ?? [];
    await intake.handlePhoto(intakeMessageFromCtx(ctx), ctx.api, fileIds, ctx.msg?.caption);
  });

  bot.on("message:document", async (ctx: Context) => {
    const doc = ctx.msg?.document;
    if (!doc?.file_id) return;
    await intake.handleDocument(intakeMessageFromCtx(ctx), ctx.api, {
      fileId: doc.file_id,
      fileName: doc.file_name,
      mimeType: doc.mime_type,
      caption: ctx.msg?.caption,
    });
  });

  bot.on("message:voice", async (ctx: Context) => {
    const voice = ctx.msg?.voice;
    if (!voice?.file_id) return;
    await intake.handleVoice(intakeMessageFromCtx(ctx), ctx.api, {
      fileId: voice.file_id,
      mimeType: voice.mime_type,
    });
  });

  bot.on("message:audio", async (ctx: Context) => {
    const audio = ctx.msg?.audio;
    if (!audio?.file_id) return;
    await intake.handleAudio(intakeMessageFromCtx(ctx), ctx.api, {
      fileId: audio.file_id,
      fileName: audio.file_name,
      performer: audio.performer,
      title: audio.title,
      caption: ctx.msg?.caption,
    });
  });

  bot.on("message:forum_topic_created", async (ctx: Context) => {
    await intake.handleTopicDescription(
      ctx.chat?.id,
      ctx.msg?.message_thread_id,
      ctx.msg?.forum_topic_created?.name,
    );
  });

  bot.on("message:forum_topic_edited", async (ctx: Context) => {
    await intake.handleTopicDescription(
      ctx.chat?.id,
      ctx.msg?.message_thread_id,
      ctx.msg?.forum_topic_edited?.name,
    );
  });

  // Guest Mode (Bot API 10.0): a @mention in a chat the bot is NOT a member of.
  // The allowlist middleware gates these by summoner before this handler runs.
  // Reply is one-shot via ctx.answerGuestQuery (it auto-reads guest_query_id
  // from ctx.guestMessage) — no streaming. Media/caption-only summons are out
  // of scope: we drop them silently with a debug log. See telegram-guest-mode.
  bot.on("guest_message", async (ctx: Context) => {
    const guestMessage = ctx.guestMessage;
    if (!guestMessage) return;
    const text = guestMessage.text;
    if (!text) {
      // Media (photo/document/voice) or caption-only — Non-Goal, drop quietly.
      log.debug("dropping guest_message: no text", {
        chatId: guestMessage.chat?.id,
        hasCaption: "caption" in guestMessage,
      });
      return;
    }
    const cleanedText = prepareUserContent(ctx, text);
    await intake.handleGuestMessage(
      {
        chatId: guestMessage.chat.id,
        replyVia: (result) => ctx.answerGuestQuery(result),
      },
      cleanedText,
    );
  });

  bot.catch((err) => {
    log.error("bot error", {
      name: err.error instanceof Error ? err.error.name : typeof err.error,
      message: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  return { bot, manager, subagentRunner, agentRunners: runners, scheduleStore, dispatcher: intake.dispatcher };
}
