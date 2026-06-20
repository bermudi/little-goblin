import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { log } from "./log.ts";
import { buildAllowlistMiddleware, locatorFromCtx, MessageBuffer } from "./tg/mod.ts";
import { prepareUserContent } from "./tg/user-context.ts";
import {
  createSendVoiceTool,
  createSendPhotoTool,
  createSendDocumentTool,
  createRenameTopicTool,
} from "./tg/tools.ts";
import { MemoryStore } from "./memory/mod.ts";
import { registerCommands } from "./commands/mod.ts";
import { SessionManager, type ChatLocator, type SessionState } from "./sessions/mod.ts";
import { AgentRunner, ModelNotCapableError } from "./agent/mod.ts";
import { resolveModel, type ResolvedModel } from "./agent/models.ts";
import { SubagentRunner, type SubagentToolFactory } from "./subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "./subagents/tool.ts";
import { interruptAndCascade } from "./interrupt.ts";
import { parseCommand } from "./commands/parse.ts";
import { handleCancelCapableCommand, type DispatchDeps } from "./commands/dispatch.ts";

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

function buildGetTopicName(store: MemoryStore): (chatId: number, topicId: number) => Promise<string | null> {
  return async (chatId, topicId) => {
    const { description } = store.read({ topic: { chatId, topicId } });
    return description ?? null;
  };
}

/** Create the standard β‑tools for a chat surface. */
function getBetaTools(
  bot: Bot,
  chatId: number,
  topicId?: number,
): ToolDefinition[] {
  return [
    createSendVoiceTool(bot, chatId, topicId),
    createSendPhotoTool(bot, chatId, topicId),
    createSendDocumentTool(bot, chatId, topicId),
    createRenameTopicTool(bot, chatId, topicId),
  ].filter((t): t is NonNullable<typeof t> => t !== null);
}

/** Telegram Bot API max download size (20 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Download a Telegram file by file_id and return the raw bytes.
 * Returns null on any failure.
 */
async function downloadFileBytes(
  api: Bot["api"],
  fileId: string,
  botToken: string,
): Promise<Uint8Array | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) return null;

    // Encode path segments defensively; Telegram paths are typically
    // well-formed but the spec doesn't guarantee ASCII-only.
    const encodedPath = file.file_path
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const resp = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${encodedPath}`,
      { signal: AbortSignal.timeout(30_000) },
    );

    if (!resp.ok) {
      log.warn("failed to download file: bad status", { fileId, status: resp.status });
      return null;
    }

    // Reject files that exceed Telegram's Bot API download limit
    const contentLength = resp.headers.get("content-length");
    if (contentLength !== null) {
      const bytes = Number(contentLength);
      if (!Number.isFinite(bytes) || bytes > MAX_FILE_BYTES) {
        log.warn("file too large", { fileId, contentLength: bytes, maxBytes: MAX_FILE_BYTES });
        return null;
      }
    }

    const raw = new Uint8Array(await resp.arrayBuffer());
    if (raw.byteLength > MAX_FILE_BYTES) {
      log.warn("file too large (post-download)", { fileId, byteLength: raw.byteLength, maxBytes: MAX_FILE_BYTES });
      return null;
    }
    return raw;
  } catch (err) {
    // Never log String(err) — the URL embeds the bot token and fetch
    // errors can include the full URL in their message.
    log.warn("failed to download file", { fileId, code: (err as { code?: string }).code });
    return null;
  }
}

/**
 * Download a Telegram file by file_id and return it as base64-encoded data
 * suitable for pi's ImageContent. Returns null on any failure.
 */
async function downloadFile(
  api: Bot["api"],
  fileId: string,
  botToken: string,
  mimeType = "image/jpeg",
): Promise<{ data: string; mimeType: string } | null> {
  const raw = await downloadFileBytes(api, fileId, botToken);
  if (!raw) return null;

  // Chunk base64 encoding to avoid call-stack overflow on large payloads
  const CHUNK = 48 * 1024; // multiple of 3 for clean base64 grouping
  let data = "";
  for (let i = 0; i < raw.length; i += CHUNK) {
    const slice = raw.subarray(i, i + CHUNK);
    data += btoa(String.fromCharCode(...slice));
  }
  return { data, mimeType };
}

/**
 * Download the largest photo from a Telegram photo message.
 * Returns null on any failure.
 */
async function downloadPhoto(
  ctx: Context,
  botToken: string,
): Promise<{ data: string; mimeType: string } | null> {
  const photoSizes = ctx.msg?.photo;
  if (!photoSizes || photoSizes.length === 0) return null;
  const largest = photoSizes[photoSizes.length - 1]!;
  return downloadFile(ctx.api, largest.file_id, botToken);
}

/**
 * Reply to the user that they need an active session, and log the drop.
 * Only pings the user in DMs — in topics, we silently drop to avoid
 * spamming every topic in a forum with the same prompt. Always logs.
 */
export function replyNoActiveSession(ctx: Context, locator: ChatLocator, kind: string): void {
  if (locator.topicId === undefined) {
    ctx.reply("No active session. Use /new to start one.").catch((err: unknown) => {
      log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
    });
  }
  log.debug(`dropping ${kind}: no session`, { chatId: locator.chatId, topicId: locator.topicId });
}

/**
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
interface BuildBotOptions {
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
}

export function buildBot(cfg: Config, options: BuildBotOptions = {}): { bot: Bot; manager: SessionManager; subagentRunner: SubagentRunner; agentRunners: Map<string, AgentRunner> } {
  const bot = new Bot(cfg.botToken);
  const manager = new SessionManager(cfg);
  const runners = new Map<string, AgentRunner>();
  const subagentRunner = new SubagentRunner(cfg, subagentToolFactory);
  const memoryStore = new MemoryStore(cfg.goblinHome);
  const getTopicName = buildGetTopicName(memoryStore);

  /** Resolve the current model for a session, return undefined on failure. */
  function tryResolveModel(cfg: Config, session: SessionState | null, runner?: AgentRunner): ResolvedModel | undefined {
    try {
      const modelName = runner?.modelName ?? session?.modelName ?? cfg.modelName;
      return resolveModel({ ...cfg, modelName });
    } catch {
      return undefined;
    }
  }

  function createRunner(session: SessionState, locator: ChatLocator, ctx: Context): AgentRunner {
    const chatId = locator.chatId;
    // Use the raw message_thread_id (NOT locator.topicId) so that
    // "General" topics in a forum still get a thread-scoped β-tool set.
    // locator.topicId filters out non-topic messages; that's the right
    // call for memory scoping (see createMessageBuffer) but wrong for
    // Telegram API calls, which need the actual thread id.
    const topicId = ctx.message?.message_thread_id;
    const betaTools = getBetaTools(bot, chatId, topicId);
    const runnerOpts: ConstructorParameters<typeof AgentRunner>[0] = {
      cfg,
      sessionId: session.id,
      locator,
      customTools: betaTools,
      subagentRunner,
      getTopicName,
      projectDir: manager.getProjectDir(locator),
      modelName: session.modelName,
      thinkingLevel: session.thinkingLevel,
      pendingProjectNotice: manager.consumeProjectNotice(locator),
    };
    return options.createAgentRunner?.(runnerOpts) ?? new AgentRunner(runnerOpts);
  }

  function getOrCreateRunner(session: SessionState, locator: ChatLocator, ctx: Context): AgentRunner {
    const existing = runners.get(session.id);
    if (existing) return existing;

    const runner = createRunner(session, locator, ctx);
    runners.set(session.id, runner);
    log.debug("created runner for session", { sessionId: session.id });
    return runner;
  }

  /**
   * Build a per-turn MessageBuffer. One buffer per prompt so message IDs
   * stay scoped to this turn. Wires the topic-orphan archival hook: if
   * Telegram reports "topic not found" while we're streaming into a
   * topic, archive the orphaned memory scope before the error propagates.
   */
  function createMessageBuffer(locator: ChatLocator): MessageBuffer {
    // Use locator.topicId (NOT ctx.message?.message_thread_id) so orphan
    // archival only fires for "real" forum topics. "General" topics are
    // DM-like and must not archive a memory scope when their thread
    // errors out. See createRunner for the inverse trade-off.
    const topicId = locator.topicId;
    return new MessageBuffer(bot, locator.chatId, topicId, {
      visibility: cfg.toolVisibility,
      onTopicNotFound:
        topicId !== undefined
          ? async () => {
              await memoryStore.archiveOrphan(locator.chatId, topicId);
            }
          : undefined,
    });
  }

  type PromptContent = string | (TextContent | ImageContent)[];
  type ActiveTurn = {
    locator: ChatLocator;
    session: SessionState;
    projectDir: string | undefined;
    prompt: (content: PromptContent, failureLog: string, opts?: { replyModelNotCapable?: boolean }) => Promise<void>;
  };

  function resolveActiveTurn(ctx: Context, kind: string): ActiveTurn | null {
    const locator = locatorFromCtx(ctx);
    if (!locator) {
      log.debug(`dropping ${kind}: no locator`);
      return null;
    }

    const isSupergroup = ctx.chat?.type === "supergroup";
    const session = manager.resolve(locator, { isSupergroup });
    if (!session) {
      replyNoActiveSession(ctx, locator, kind);
      return null;
    }

    return {
      locator,
      session,
      projectDir: manager.getProjectDir(locator),
      prompt: async (content, failureLog, opts) => {
        const runner = getOrCreateRunner(session, locator, ctx);
        const buffer = createMessageBuffer(locator);
        try {
          if (typeof content === "string") {
            await runner.prompt(prepareUserContent(ctx, content), buffer);
          } else {
            await runner.prompt(prepareUserContent(ctx, content), buffer);
          }
        } catch (err) {
          if (opts?.replyModelNotCapable && err instanceof ModelNotCapableError) {
            await ctx.reply(`❌ ${err.message}`);
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          log.error(failureLog, { error: msg, sessionId: session.id });
        }
      },
    };
  }

  const dispatchDeps: DispatchDeps = {
    manager,
    subagentRunner,
    cfg,
    tryResolveModel,
    interruptAndCascade,
  };

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
      try {
        const result = await handleCancelCapableCommand({
          command,
          deps: dispatchDeps,
          rawText: rawText ?? "",
          locator,
          isSupergroup,
          session,
          existingRunner,
        });
        if (result.kind !== "fallthrough") {
          for (const effect of result.sideEffects) {
            if (effect.kind === "runner-created") {
              runners.set(effect.session.id, createRunner(effect.session, effect.locator, ctx));
              log.debug("created runner", { sessionId: effect.session.id });
            } else if (effect.kind === "runner-disposed") {
              const prior = runners.get(effect.sessionId);
              if (prior) {
                try {
                  prior.dispose();
                } finally {
                  runners.delete(effect.sessionId);
                }
              } else {
                runners.delete(effect.sessionId);
              }
            }
          }
          await ctx.reply(result.reply);
          return;
        }
      } catch (err) {
        log.error("command dispatch failed", { error: String(err), command, sessionId: session?.id });
        await ctx.reply("Something went wrong. Please try again.");
        return;
      }
    }

    if (!session) {
      replyNoActiveSession(ctx, locator, "message");
      return;
    }

    const runner = getOrCreateRunner(session, locator, ctx);

    const text = ctx.msg?.text;
    if (!text) return;

    // MessageBuffer turns agent events into Telegram UI (status line + streamed
    // response). One buffer per turn so message IDs are scoped to this prompt.
    // Wire up orphan archival: if Telegram reports "topic not found", archive
    // the orphaned memory scope before propagating the error.
    const buffer = createMessageBuffer(locator);

    try {
      await runner.prompt(prepareUserContent(ctx, text), buffer);
    } catch (err) {
      log.error("runner prompt failed", { error: String(err), sessionId: session.id });
    }
  });

  // Wire agent runner for photo messages
  bot.on("message:photo", async (ctx: Context) => {
    const turn = resolveActiveTurn(ctx, "photo");
    if (!turn) return;

    // Download the photo from Telegram
    const photo = await downloadPhoto(ctx, cfg.botToken);
    if (!photo) {
      await ctx.reply("Sorry, I couldn't download that image.");
      return;
    }

    // Build multimodal content: caption as text, photo as image
    const caption = ctx.msg?.caption;
    const content: (TextContent | ImageContent)[] = [];
    if (caption) {
      content.push({ type: "text", text: caption });
    }
    content.push({ type: "image", data: photo.data, mimeType: photo.mimeType });

    await turn.prompt(content, "runner photo prompt failed", { replyModelNotCapable: true });
  });

  // Wire agent runner for document messages (uncompressed images sent as files)
  bot.on("message:document", async (ctx: Context) => {
    const turn = resolveActiveTurn(ctx, "document");
    if (!turn) return;

    const doc = ctx.msg?.document;
    if (!doc?.file_id) return;

    // All documents (including images sent as files) are saved to projectDir.
    // Only message:photo goes directly to the model as multimodal content.
    if (turn.projectDir) {
      const raw = await downloadFileBytes(ctx.api, doc.file_id, cfg.botToken);
      if (!raw) {
        await ctx.reply("Sorry, I couldn't download that file.");
        return;
      }

      let safeName = basename(doc.file_name || "attachment").trim() || "attachment";
      if (safeName === "." || safeName === "..") {
        await ctx.reply("Rejected: unsafe filename.");
        return;
      }
      const destPath = join(turn.projectDir, safeName);
      try {
        await writeFile(destPath, raw);
      } catch (err) {
        log.error("failed to write attachment to project directory", { error: String(err), destPath });
        await ctx.reply(`Failed to save ${safeName}.`);
        return;
      }

      await ctx.reply(`Saved ${safeName}.`);

      // Escape backticks so the file name doesn't break markdown in the prompt
      const escapedName = safeName.replace(/`/g, "'");
      const caption = ctx.msg?.caption;
      const promptText = caption
        ? `${caption}\n\n[File \`${escapedName}\` saved to project directory.]`
        : `User uploaded \`${escapedName}\` to the project directory.`;

      await turn.prompt(promptText, "runner document prompt failed");
      return;
    }

    log.debug("dropping document: no projectDir", { mimeType: doc.mime_type, fileName: doc.file_name });
    // Forward the caption as a text-only prompt so the user's message
    // isn't completely lost. If there's no caption either, tell them.
    const fallbackCaption = ctx.msg?.caption;
    if (fallbackCaption) {
      await turn.prompt(fallbackCaption, "runner document caption prompt failed");
    } else {
      await ctx.reply("No project directory is set. Use /project <path> to enable file saving.");
    }
  });

  // Wire agent runner for voice messages
  bot.on("message:voice", async (ctx: Context) => {
    const turn = resolveActiveTurn(ctx, "voice");
    if (!turn) return;

    const voice = ctx.msg?.voice;
    if (!voice?.file_id) return;

    if (turn.projectDir) {
      const raw = await downloadFileBytes(ctx.api, voice.file_id, cfg.botToken);
      if (!raw) {
        await ctx.reply("Sorry, I couldn't download that voice message.");
        return;
      }

      const ext = voice.mime_type === "audio/ogg" ? "oga" : "bin";
      const safeName = `voice-${Date.now()}.${ext}`;
      const destPath = join(turn.projectDir, safeName);
      try {
        await writeFile(destPath, raw);
      } catch (err) {
        log.error("failed to write voice to project directory", { error: String(err), destPath });
        await ctx.reply(`Failed to save ${safeName}.`);
        return;
      }

      await ctx.reply(`Saved ${safeName}.`);

      const escapedName = safeName.replace(/`/g, "'");
      const promptText = `User sent a voice message: \`${escapedName}\` saved to project directory.`;

      await turn.prompt(promptText, "runner voice prompt failed");
      return;
    }

    log.debug("dropping voice: no projectDir");
    await ctx.reply("No project directory is set. Use /project <path> to enable file saving.");
  });

  // Wire agent runner for audio messages (music files)
  bot.on("message:audio", async (ctx: Context) => {
    const turn = resolveActiveTurn(ctx, "audio");
    if (!turn) return;

    const audio = ctx.msg?.audio;
    if (!audio?.file_id) return;

    if (turn.projectDir) {
      const raw = await downloadFileBytes(ctx.api, audio.file_id, cfg.botToken);
      if (!raw) {
        await ctx.reply("Sorry, I couldn't download that audio file.");
        return;
      }

      let safeName = audio.file_name?.trim();
      if (!safeName) {
        const title = [audio.performer, audio.title].filter(Boolean).join(" - ");
        safeName = title ? `${title}.mp3` : `audio-${Date.now()}.mp3`;
      }
      safeName = basename(safeName);
      if (safeName === "." || safeName === "..") {
        await ctx.reply("Rejected: unsafe filename.");
        return;
      }
      const destPath = join(turn.projectDir, safeName);
      try {
        await writeFile(destPath, raw);
      } catch (err) {
        log.error("failed to write audio to project directory", { error: String(err), destPath });
        await ctx.reply(`Failed to save ${safeName}.`);
        return;
      }

      await ctx.reply(`Saved ${safeName}.`);

      const escapedName = safeName.replace(/`/g, "'");
      const caption = ctx.msg?.caption;
      const promptText = caption
        ? `${caption}\n\n[Audio file \`${escapedName}\` saved to project directory.]`
        : `User uploaded audio \`${escapedName}\` to the project directory.`;

      await turn.prompt(promptText, "runner audio prompt failed");
      return;
    }

    log.debug("dropping audio: no projectDir");
    const fallbackCaption = ctx.msg?.caption;
    if (fallbackCaption) {
      await turn.prompt(fallbackCaption, "runner audio caption prompt failed");
    } else {
      await ctx.reply("No project directory is set. Use /project <path> to enable file saving.");
    }
  });

  // Persist topic names from Telegram service messages so the snapshot
  // and memory index can show human-readable names instead of bare IDs.
  bot.on("message:forum_topic_created", async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const topic = ctx.msg?.forum_topic_created;
    const threadId = ctx.msg?.message_thread_id;
    if (chatId === undefined || topic === undefined || threadId === undefined) return;
    try {
      await memoryStore.setDescription(
        { topic: { chatId, topicId: threadId } },
        topic.name,
      );
    } catch {
      // Silently ignore — bot may lack admin rights to read the topic,
      // or the scope directory may not exist yet. The name will be
      // captured on the next rename or when the agent sets a description.
    }
  });

  bot.on("message:forum_topic_edited", async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const edit = ctx.msg?.forum_topic_edited;
    const threadId = ctx.msg?.message_thread_id;
    if (chatId === undefined || edit === undefined || threadId === undefined) return;
    if (edit.name === undefined) return; // icon-only change
    try {
      await memoryStore.setDescription(
        { topic: { chatId, topicId: threadId } },
        edit.name,
      );
    } catch {
      // Same silent-ignore rationale as forum_topic_created.
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
