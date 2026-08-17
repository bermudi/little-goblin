import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { buildAllowlistMiddleware, surfaceFromCtx, TextCoalescer } from "./tg/mod.ts";
import { prepareUserContent } from "./tg/user-context.ts";
import { MemoryEngine } from "./memory/mod.ts";
import { MetricsStore, type TelegramMetricsEvent } from "./metrics/mod.ts";
import { classifyTelegramError, type ReplyOpts } from "./tg/format.ts";
import { registerCommands } from "./commands/mod.ts";
import type { ConversationState } from "./sessions/mod.ts";
import { guestSurface, surfaceId, type Surface } from "./surface.ts";
import { AgentRunner } from "./agent/mod.ts";
import { SubagentRunner, PiSubagentHost, type SubagentToolFactory } from "./subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "./subagents/tool.ts";
import { configureVoice } from "./voice.ts";
import { ScheduleStore } from "./scheduler/store.ts";
import {
  createTelegramIntake,
  replyNoActiveSession as replyNoActiveSessionForMessage,
  type PromptContent,
  type TelegramIntakeMessage,
} from "./tg/intake.ts";
import { createTelegramRuntimeAdapters } from "./tg/runtime-adapters.ts";
import { ExternalAgentRunner } from "./external-agents/mod.ts";
import { McpRunner } from "./mcp/mod.ts";
import { DelegatedWorkHost } from "./delegated-work/mod.ts";
import type { TurnDispatcher } from "./orchestration/dispatcher.ts";
import type { ConversationLifecycle } from "./orchestration/conversation-lifecycle.ts";
import { createConversationOrchestration } from "./orchestration/composition.ts";
import type { ConversationRuntimeHost } from "./orchestration/conversation-runtime-host.ts";
import { UpdateGate, type AdmissionHandle } from "./shutdown/mod.ts";

/**
 * Tool factory that equips spawned subagents with spawn_subagent
 * and revive_subagent, enabling recursive spawning up to the depth cap.
 */
const subagentToolFactory: SubagentToolFactory = (
  runner,
  depth,
  sessionId,
  parentCapture,
  inheritance,
  onStatusUpdate,
  delegatedContext,
  parentSubagentId,
) => [
  createSpawnSubagentTool(
    runner,
    depth,
    sessionId,
    parentCapture,
    inheritance,
    onStatusUpdate,
    undefined,
    delegatedContext,
    parentSubagentId,
  ),
  createReviveSubagentTool(
    runner,
    parentCapture,
    inheritance,
    onStatusUpdate,
    undefined,
    delegatedContext,
  ),
];

function safeRecordTelegramEvent(metrics: MetricsStore | undefined, event: TelegramMetricsEvent): void {
  if (!metrics) return;
  try {
    metrics.record(event);
  } catch (err) {
    log.warn("failed to record system reply metric", { error: String(err) });
  }
}

/**
 * Resolve the `MetricsStore` for a system reply, swallowing resolution errors.
 * Lifecycle inspection can throw on non-`ENOENT` filesystem errors (fail-loud
 * rule); a resolution failure after a successful `ctx.reply` must not be
 * treated as a reply failure, so we log and return `undefined` instead.
 */
async function safeGetMetrics(
  getMetrics: () => MetricsStore | undefined | Promise<MetricsStore | undefined>,
): Promise<MetricsStore | undefined> {
  try {
    return await getMetrics();
  } catch (err) {
    log.warn("failed to resolve metrics store for system reply", { error: String(err) });
    return undefined;
  }
}

function wrapReply(
  reply: (text: string, opts?: ReplyOpts) => Promise<void>,
  getMetrics: () => MetricsStore | undefined | Promise<MetricsStore | undefined>,
): (text: string, opts?: ReplyOpts) => Promise<void> {
  return async (text, opts) => {
    try {
      await reply(text, opts);
      safeRecordTelegramEvent(await safeGetMetrics(getMetrics), {
        type: "telegram",
        op: "sendMessage",
        channel: "system",
        outcome: "success",
      });
    } catch (err) {
      const { outcome, errorCode, errorDescription, retryAfterSec } = classifyTelegramError(err);
      safeRecordTelegramEvent(await safeGetMetrics(getMetrics), {
        type: "telegram",
        op: "sendMessage",
        channel: "system",
        outcome,
        errorCode,
        errorDescription,
        retryAfterSec,
      });
      throw err;
    }
  };
}

function intakeMessageFromCtx(
  ctx: Context,
  lifecycle: { inspect(surface: Surface): ConversationState | null },
  cfg: Config,
): TelegramIntakeMessage {
  const surface = surfaceFromCtx(ctx);
  // System-reply metrics are attributed to the conversation bound at reply
  // completion time, not at message construction time. This differs from
  // MessageBuffer, which pins its MetricsStore at createMessageBuffer time.
  // Under concurrent updates that mutate bindings.json (e.g. a /resume or
  // /archive racing with an in-flight reply), the metric may be attributed
  // to the wrong conversation or dropped. This is accepted for system replies
  // because they are fire-and-forget and single-user; pinning at construction
  // would lose metrics for /new replies (the conversation does not exist yet at
  // intakeMessageFromCtx time).
  const getMetrics = async (): Promise<MetricsStore | undefined> => {
    if (!surface) return undefined;
    const conversation = lifecycle.inspect(surface);
    return conversation ? new MetricsStore(cfg.goblinHome, conversation.id) : undefined;
  };
  return {
    surface,
    reply: wrapReply(async (text, opts) => {
      await ctx.reply(text, opts as Record<string, unknown> | undefined);
    }, getMetrics),
    prepare: (content: PromptContent): PromptContent => {
      if (typeof content === "string") return prepareUserContent(ctx, content);
      return prepareUserContent(ctx, content);
    },
  };
}

/**
 * Reply to the user that they need an active conversation, and log the drop.
 * Only pings the user in DMs — in topics, we silently drop to avoid
 * spamming every topic in a forum with the same prompt. Always logs.
 */
export function replyNoActiveSession(ctx: Context, surface: Surface, kind: string): void {
  replyNoActiveSessionForMessage({
    surface,
    reply: wrapReply(async (text, opts) => {
      await ctx.reply(text, opts as Record<string, unknown> | undefined);
    }, () => undefined),
    prepare: (content) => content,
  }, surface, kind);
}

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
interface BuildBotOptions {
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  /** Optional pre-built memory engine; a default one is constructed when absent. */
  memoryEngine?: MemoryEngine;
}

export interface BuiltBot {
  bot: Bot;
  /** Process-level update gate. Owns admission tracking, the coalescer close
   * coupling, and the three drain barriers. The shutdown coordinator calls
   * `gate.closeAdmission()`, `gate.bufferedTextAdmission()`, and
   * `gate.runtimeAdmission()` in the documented phase order. */
  gate: UpdateGate;
  lifecycle: ConversationLifecycle;
  runtimeHost: ConversationRuntimeHost;
  subagentRunner: SubagentRunner;
  scheduleStore: ScheduleStore;
  dispatcher: TurnDispatcher;
  externalAgentRunner: ExternalAgentRunner | undefined;
  mcpRunner: McpRunner | undefined;
  memoryEngine: MemoryEngine;
}

export function buildBot(cfg: Config, options: BuildBotOptions = {}): BuiltBot {
  configureVoice(cfg);
  const bot = new Bot(cfg.botToken);
  const memoryEngine = options.memoryEngine ?? new MemoryEngine(cfg.goblinHome, cfg.openaiApiKey);
  const memoryStore = memoryEngine.readStore;
  const delegatedWorkHost = new DelegatedWorkHost(cfg.goblinHome);
  const subagentHost = new PiSubagentHost(cfg);
  const subagentRunner = new SubagentRunner(
    cfg,
    subagentToolFactory,
    memoryEngine.embeddingProvider,
    subagentHost,
    undefined,
    delegatedWorkHost,
  );
  // One shared schedule store: `/schedule` mutates it from the command path,
  // and the scheduler loop reads/claims from it. Constructed here so both
  // intake and the loop (wired in index.ts) share a single instance.
  const scheduleStore = new ScheduleStore(cfg.goblinHome);
  // External agent runner is only created when at least one backend is enabled.
  const externalAgentRunner = cfg.externalAgents?.backends.length ? new ExternalAgentRunner(cfg) : undefined;
  const mcpRunner = cfg.mcp ? new McpRunner(cfg.mcp, cfg.goblinHome) : undefined;
  const telegramAdapters = createTelegramRuntimeAdapters({ cfg, bot, memoryStore });
  const orchestration = createConversationOrchestration({
    cfg,
    subagentRunner,
    memoryStore,
    createAgentRunner: options.createAgentRunner,
    createMessageBuffer: telegramAdapters.createMessageBuffer,
    createBetaTools: telegramAdapters.createBetaTools,
    scheduleStore,
    externalAgentRunner,
    mcpRunner,
    embeddingProvider: memoryEngine.embeddingProvider,
    dreamingPipeline: memoryEngine.dreaming,
  });
  // Process-level update gate. Absorbs the admission tracking, drain
  // barriers, and coalescer close coupling that previously lived as local
  // state in this closure. The coalescer callbacks are wired through mutable
  // bindings so the gate can be constructed before the coalescer exists
  // (breaking the gate ↔ intake ↔ coalescer construction cycle).
  let coalescerClose = async (): Promise<void> => {};
  let coalescerBufferedAdmission = async (): Promise<void> => {};
  const gate = new UpdateGate({
    closeCoalescer: () => coalescerClose(),
    awaitBufferedTextAdmission: () => coalescerBufferedAdmission(),
  });

  const intake = createTelegramIntake({
    cfg,
    bot,
    subagentRunner,
    memoryStore,
    dispatcher: orchestration.dispatcher,
    lifecycle: orchestration.lifecycle,
    scheduleStore,
    externalAgentRunner,
    gate,
  });

  // Text coalescer: merges Telegram-split fragments before they reach intake.
  // One instance shared across all message:text handlers, keyed per
  // (chatId, topicId, fromUserId). See src/tg/coalesce.ts.
  //
  // The coalescer tracks every dispatch, including timer-originated work, and
  // propagates failures from its close drain. Immediate handler promises still
  // flow to grammy's error boundary.
  const coalescer = new TextCoalescer({
    dispatch: (msg, text, handle) => intake.handleText(msg, text, handle),
  });
  coalescerClose = (): Promise<void> => coalescer.close();
  coalescerBufferedAdmission = (): Promise<void> => coalescer.bufferedTextAdmission();

  // Track updates before authorization. Authorization can make an asynchronous
  // Telegram API call (member count for an allowed user in a group), and
  // grammy confirms an update's offset once its middleware settles. A shutdown
  // must therefore wait for this authorization decision before closing the
  // coalescer, or an already-fetched update can be lost forever.
  bot.use((_ctx, next) => {
    if (!gate.isOuterOpen()) {
      log.info("Telegram update dropped after admission closed");
      return Promise.resolve();
    }
    const handle: AdmissionHandle = gate.beginUpdate(_ctx);
    let downstream: Promise<void>;
    try {
      downstream = next();
    } catch (err) {
      handle.releaseAuthorization();
      handle.releaseRuntimeAdmission();
      throw err;
    }
    gate.settleUpdate(_ctx, downstream);
    return gate.trackAdmitted(downstream);
  });
  bot.use(buildAllowlistMiddleware(cfg));
  // Reaching this middleware means allowlist authorization succeeded. A
  // denied update never reaches it; the outer tracking middleware releases its
  // authorization barrier when the denial returns.
  bot.use((_ctx, next) => {
    gate.handleFor(_ctx)?.releaseAuthorization();
    return next();
  });
  registerCommands(bot, intake.lifecycle);

  bot.on("message:text", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    const message = intakeMessageFromCtx(ctx, intake.lifecycle, cfg);
    // No valid chat → drop, same as the handler did before coalescing.
    if (!message.surface) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    // Telegram always populates `from` on user-originated text messages and
    // `message_id` on Message objects, and the allowlist middleware has already
    // gated this update. Guard defensively anyway so a future invariant shift
    // fails here rather than producing a bogus key.
    const fromId = ctx.from?.id;
    const messageId = ctx.msg?.message_id;
    if (fromId === undefined || messageId === undefined) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    if (handle) handle.markHandedToCoalescer();
    await coalescer.submit({
      message,
      text: ctx.msg?.text ?? "",
      key: {
        surfaceId: message.surface ? surfaceId(message.surface) : "unknown",
        fromUserId: fromId,
      },
      messageId,
      // The first entity being bot_command means this is a slash command.
      // Commands bypass the coalescer (and flush any pending buffer first) —
      // so a slash command whose ARGUMENT exceeds Telegram's 4096-char limit
      // will be split, with the first fragment dispatched immediately as a
      // (truncated) command and the rest treated as a separate text turn.
      // No command in this codebase accepts a >4096-char argument, so this is
      // accepted as a known limitation rather than handled by coalescing.
      isCommand: ctx.msg?.entities?.[0]?.type === "bot_command",
      handle,
    });
  });

  bot.on("message:photo", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    const fileIds = ctx.msg?.photo?.map((photo) => photo.file_id) ?? [];
    await intake.handlePhoto(intakeMessageFromCtx(ctx, intake.lifecycle, cfg), ctx.api, fileIds, ctx.msg?.caption, handle);
  });

  bot.on("message:document", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    const doc = ctx.msg?.document;
    if (!doc?.file_id) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    await intake.handleDocument(intakeMessageFromCtx(ctx, intake.lifecycle, cfg), ctx.api, {
      fileId: doc.file_id,
      fileName: doc.file_name,
      mimeType: doc.mime_type,
      caption: ctx.msg?.caption,
    }, handle);
  });

  bot.on("message:voice", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    const voice = ctx.msg?.voice;
    if (!voice?.file_id) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    await intake.handleVoice(intakeMessageFromCtx(ctx, intake.lifecycle, cfg), ctx.api, {
      fileId: voice.file_id,
      mimeType: voice.mime_type,
    }, handle);
  });

  bot.on("message:audio", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    const audio = ctx.msg?.audio;
    if (!audio?.file_id) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    await intake.handleAudio(intakeMessageFromCtx(ctx, intake.lifecycle, cfg), ctx.api, {
      fileId: audio.file_id,
      fileName: audio.file_name,
      performer: audio.performer,
      title: audio.title,
      caption: ctx.msg?.caption,
    }, handle);
  });

  bot.on("message:forum_topic_created", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    await intake.handleTopicDescription(
      ctx.chat?.id,
      ctx.msg?.message_thread_id,
      ctx.msg?.forum_topic_created?.name,
      handle,
    );
  });

  bot.on("message:forum_topic_edited", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    await intake.handleTopicDescription(
      ctx.chat?.id,
      ctx.msg?.message_thread_id,
      ctx.msg?.forum_topic_edited?.name,
      handle,
    );
  });

  // Guest Mode (Bot API 10.0): a @mention in a chat the bot is NOT a member of.
  // The allowlist middleware gates these by summoner before this handler runs.
  // Reply is one-shot via ctx.answerGuestQuery (it auto-reads guest_query_id
  // from ctx.guestMessage) — no streaming. Media/caption-only summons are out
  // of scope: we drop them silently with a debug log. See telegram-guest-mode.
  bot.on("guest_message", async (ctx: Context) => {
    const handle = gate.handleFor(ctx);
    const guestMessage = ctx.guestMessage;
    if (!guestMessage) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const text = guestMessage.text;
    if (!text) {
      // Media (photo/document/voice) or caption-only — Non-Goal, drop quietly.
      log.debug("dropping guest_message: no text", {
        chatId: guestMessage.chat?.id,
        hasCaption: "caption" in guestMessage,
      });
      handle?.releaseRuntimeAdmission();
      return;
    }
    const cleanedText = prepareUserContent(ctx, text);
    const surface = guestSurface(guestMessage.chat.id);
    await intake.handleGuestMessage(
      {
        surface,
        replyVia: (result) => ctx.answerGuestQuery(result),
      },
      cleanedText,
      handle,
    );
  });

  bot.catch((err) => {
    log.error("bot error", {
      name: err.error instanceof Error ? err.error.name : typeof err.error,
      message: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  return {
    bot,
    gate,
    lifecycle: intake.lifecycle,
    runtimeHost: orchestration.runtimeHost,
    subagentRunner,
    scheduleStore,
    dispatcher: intake.dispatcher,
    externalAgentRunner,
    mcpRunner,
    memoryEngine,
  };
}
