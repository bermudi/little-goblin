import { existsSync } from "node:fs";
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
import { sessionDir } from "./sessions/paths.ts";
import { AgentRunner, ModelNotCapableError } from "./agent/mod.ts";
import { resolveModel, type ResolvedModel } from "./agent/models.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SubagentRunner, type SubagentToolFactory } from "./subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "./subagents/tool.ts";
import { interruptAndCascade, DEFAULT_CASCADE_TIMEOUT_MS, type CascadeResult } from "./interrupt.ts";
import { cancelReply, formatCascadeTimeoutSuffix } from "./commands/cancel.ts";
import { executeNew } from "./commands/new.ts";
import { executeArchive } from "./commands/archive.ts";
import { executeProject } from "./commands/project.ts";
import { executeModel } from "./commands/model.ts";
import { executeCompact } from "./commands/compact.ts";
import { executeName } from "./commands/name.ts";
import { executeResume } from "./commands/resume.ts";
import { executeThink, ALL_LEVELS } from "./commands/think.ts";
import { parseCommand } from "./commands/parse.ts";
import { parseSubagentId, SUBAGENT_STUB_REPLY } from "./commands/subagents.ts";
import { HELP_REPLY } from "./commands/help.ts";
import { generateDiagnostics } from "./diagnostics.ts";

/** Slash-commands that trigger an interrupt + cascade-cancel before executing. */
const CANCEL_CAPABLE_COMMANDS = new Set(["/cancel", "/new", "/archive", "/project", "/model", "/debug", "/compact", "/resume", "/name", "/think"]);

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
 * Build the grammy Bot with middleware and handlers wired up.
 * Exported so main can start the bot.
 */
export function buildBot(cfg: Config): { bot: Bot; manager: SessionManager; subagentRunner: SubagentRunner; agentRunners: Map<string, AgentRunner> } {
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
    const topicId = ctx.message?.message_thread_id;
    const betaTools = getBetaTools(bot, chatId, topicId);
    return new AgentRunner({
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
    });
  }

  function getOrCreateRunner(session: SessionState, locator: ChatLocator, ctx: Context): AgentRunner {
    const existing = runners.get(session.id);
    if (existing) return existing;

    const runner = createRunner(session, locator, ctx);
    runners.set(session.id, runner);
    log.debug("created runner for session", { sessionId: session.id });
    return runner;
  }

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
          // /new is a universal "switch this chat surface to a fresh
          // session" command: create a fresh session bound to the same
          // (chat, topic) / supergroup / DM slot. The prior session is
          // left on disk as an unbound resumable session; /archive is the
          // explicit "put this away" command.
          const priorSession = session;
          let result;
          try {
            result = executeNew({
              createSession: () =>
                manager.createForChat(locator, { isSupergroup: isSupergroupChat }),
            });
          } catch (err) {
            log.error("new session creation failed", {
              error: String(err),
              sessionId: priorSession?.id,
            });
            await ctx.reply("Failed to reset session. Please try again.");
            return;
          }
          if (priorSession) {
            const prior = runners.get(priorSession.id);
            if (prior) {
              try {
                prior.dispose();
              } finally {
                runners.delete(priorSession.id);
              }
            }
          }
          runners.set(result.session.id, createRunner(result.session, locator, ctx));
          log.debug("created runner for /new session", {
            sessionId: result.session.id,
            priorSessionId: priorSession?.id,
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
                if (prior) {
                  try {
                    prior.dispose();
                  } finally {
                    runners.delete(session!.id);
                  }
                } else {
                  runners.delete(session!.id);
                }
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
                manager.bindProjectDir(locator, dir);
                // Dispose the runner so next message recreates it with the new directory.
                const prior = runners.get(session.id);
                if (prior) {
                  try {
                    prior.dispose();
                  } finally {
                    runners.delete(session.id);
                  }
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
        case "/model": {
          let modelResult;
          try {
            const currentModelResolved = tryResolveModel(cfg, session, existingRunner ?? undefined);
            modelResult = executeModel({
              hasSession: session !== null,
              rawText: rawText ?? "",
              favorites: cfg.favorites,
              cfg,
              currentModelName: existingRunner?.modelName ?? session?.modelName ?? cfg.modelName,
              currentThinkingLevel: session?.thinkingLevel,
              currentResolvedModel: currentModelResolved,
              setModelName: (name) => {
                if (!session) return;
                manager.setModelName(session.id, name);
                const prior = runners.get(session.id);
                if (prior) {
                  try {
                    prior.dispose();
                  } finally {
                    runners.delete(session.id);
                  }
                }
              },
              onThinkingLevelClamped: (newLevel) => {
                if (!session) return;
                manager.setThinkingLevel(session.id, newLevel);
              },
            });
          } catch (err) {
            log.error("model failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to switch model. Please try again.");
            return;
          }
          const modelSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${modelResult.reply}${modelSuffix}`);
          return;
        }
        case "/think": {
          let thinkResult;
          try {
            const currentModelResolved = tryResolveModel(cfg, session, existingRunner ?? undefined);
            const supportedLevels = currentModelResolved
              ? (getSupportedThinkingLevels(currentModelResolved.model) as readonly ThinkingLevel[])
              : ALL_LEVELS;
            thinkResult = executeThink({
              hasSession: session !== null,
              rawText: rawText ?? "",
              currentLevel:
                session?.thinkingLevel ?? currentModelResolved?.thinkingLevel ?? "medium",
              supportedLevels,
              setThinkingLevel: (level) => {
                if (!session) return;
                manager.setThinkingLevel(session.id, level);
                const prior = runners.get(session.id);
                if (prior) {
                  try {
                    prior.setThinkingLevel(level);
                  } catch {
                    /* best-effort */
                  }
                }
              },
            });
          } catch (err) {
            log.error("think failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to set thinking level. Please try again.");
            return;
          }
          const thinkSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${thinkResult.reply}${thinkSuffix}`);
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
        case "/compact": {
          let compactResult;
          try {
            compactResult = await executeCompact({
              hasSession: session !== null,
              rawText: rawText ?? "",
              runner: existingRunner,
            });
          } catch (err) {
            log.error("compact failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to compact session. Please try again.");
            return;
          }
          const compactSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${compactResult.reply}${compactSuffix}`);
          return;
        }
        case "/name": {
          let nameResult;
          try {
            nameResult = executeName({
              hasSession: session !== null,
              rawText: rawText ?? "",
              session,
              setTitle: (title) => {
                if (!session) return;
                manager.setTitle(session.id, title);
              },
            });
          } catch (err) {
            log.error("name failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to name session. Please try again.");
            return;
          }
          const nameSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${nameResult.reply}${nameSuffix}`);
          return;
        }
        case "/resume": {
          let resumeResult;
          try {
            resumeResult = executeResume({
              rawText: rawText ?? "",
              sessions: manager.list(),
              bindSession: (sessionId) => manager.bindExistingToChat(sessionId, locator, { isSupergroup }),
            });
          } catch (err) {
            log.error("resume failed", {
              error: String(err),
              sessionId: session?.id,
            });
            await ctx.reply("Failed to resume session. Please try again.");
            return;
          }
          if (resumeResult.kind === "resumed") {
            if (session && session.id !== resumeResult.session.id) {
              const prior = runners.get(session.id);
              if (prior) {
                try {
                  prior.dispose();
                } finally {
                  runners.delete(session.id);
                }
              }
            }
            runners.set(resumeResult.session.id, createRunner(resumeResult.session, locator, ctx));
            log.debug("created runner for /resume session", { sessionId: resumeResult.session.id });
          }
          const resumeSuffix = cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";
          await ctx.reply(`${resumeResult.reply}${resumeSuffix}`);
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

    const runner = getOrCreateRunner(session, locator, ctx);

    const text = ctx.msg?.text;
    if (!text) return;

    // MessageBuffer turns agent events into Telegram UI (status line + streamed
    // response). One buffer per turn so message IDs are scoped to this prompt.
    // Wire up orphan archival: if Telegram reports "topic not found", archive
    // the orphaned memory scope before propagating the error.
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
      await runner.prompt(prepareUserContent(ctx, text), buffer);
    } catch (err) {
      log.error("runner prompt failed", { error: String(err), sessionId: session.id });
    }
  });

  // Wire agent runner for photo messages
  bot.on("message:photo", async (ctx: Context) => {
    const locator = locatorFromCtx(ctx);
    if (!locator) {
      log.debug("dropping photo: no locator");
      return;
    }

    const isSupergroup = ctx.chat?.type === "supergroup";
    const session = manager.resolve(locator, { isSupergroup });
    if (!session) {
      if (locator.topicId === undefined) {
        ctx.reply("No active session. Use /new to start one.").catch((err: unknown) => {
          log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
        });
      }
      log.debug("dropping photo: no session", { chatId: locator.chatId, topicId: locator.topicId });
      return;
    }

    // Download the photo from Telegram
    const photo = await downloadPhoto(ctx, cfg.botToken);
    if (!photo) {
      await ctx.reply("Sorry, I couldn't download that image.");
      return;
    }

    const runner = getOrCreateRunner(session, locator, ctx);

    // Build multimodal content: caption as text, photo as image
    const caption = ctx.msg?.caption;
    const content: (TextContent | ImageContent)[] = [];
    if (caption) {
      content.push({ type: "text", text: caption });
    }
    content.push({ type: "image", data: photo.data, mimeType: photo.mimeType });

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
      await runner.prompt(prepareUserContent(ctx, content), buffer);
    } catch (err) {
      if (err instanceof ModelNotCapableError) {
        await ctx.reply(`❌ ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("runner photo prompt failed", { error: msg, sessionId: session.id });
      }
    }
  });

  // Wire agent runner for document messages (uncompressed images sent as files)
  bot.on("message:document", async (ctx: Context) => {
    const locator = locatorFromCtx(ctx);
    if (!locator) {
      log.debug("dropping document: no locator");
      return;
    }

    const isSupergroup = ctx.chat?.type === "supergroup";
    const session = manager.resolve(locator, { isSupergroup });
    if (!session) {
      if (locator.topicId === undefined) {
        ctx.reply("No active session. Use /new to start one.").catch((err: unknown) => {
          log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
        });
      }
      log.debug("dropping document: no session", { chatId: locator.chatId, topicId: locator.topicId });
      return;
    }

    const doc = ctx.msg?.document;
    if (!doc?.file_id) return;

    const runner = getOrCreateRunner(session, locator, ctx);

    // All documents (including images sent as files) are saved to projectDir.
    // Only message:photo goes directly to the model as multimodal content.
    const projectDir = manager.getProjectDir(locator);
    if (projectDir) {
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
      const destPath = join(projectDir, safeName);
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
        await runner.prompt(prepareUserContent(ctx, promptText), buffer);
      } catch (err) {
        log.error("runner document prompt failed", { error: String(err), sessionId: session.id });
      }
      return;
    }

    log.debug("dropping document: no projectDir", { mimeType: doc.mime_type, fileName: doc.file_name });
    // Forward the caption as a text-only prompt so the user's message
    // isn't completely lost. If there's no caption either, tell them.
    const fallbackCaption = ctx.msg?.caption;
    if (fallbackCaption) {
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
        await runner.prompt(prepareUserContent(ctx, fallbackCaption), buffer);
      } catch (err) {
        log.error("runner document caption prompt failed", { error: String(err), sessionId: session.id });
      }
    } else {
      await ctx.reply("No project directory is set. Use /project <path> to enable file saving.");
    }
  });

  // Wire agent runner for voice messages
  bot.on("message:voice", async (ctx: Context) => {
    const locator = locatorFromCtx(ctx);
    if (!locator) {
      log.debug("dropping voice: no locator");
      return;
    }

    const isSupergroup = ctx.chat?.type === "supergroup";
    const session = manager.resolve(locator, { isSupergroup });
    if (!session) {
      if (locator.topicId === undefined) {
        ctx.reply("No active session. Use /new to start one.").catch((err: unknown) => {
          log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
        });
      }
      log.debug("dropping voice: no session", { chatId: locator.chatId, topicId: locator.topicId });
      return;
    }

    const voice = ctx.msg?.voice;
    if (!voice?.file_id) return;

    const runner = getOrCreateRunner(session, locator, ctx);
    const projectDir = manager.getProjectDir(locator);

    if (projectDir) {
      const raw = await downloadFileBytes(ctx.api, voice.file_id, cfg.botToken);
      if (!raw) {
        await ctx.reply("Sorry, I couldn't download that voice message.");
        return;
      }

      const ext = voice.mime_type === "audio/ogg" ? "oga" : "bin";
      const safeName = `voice-${Date.now()}.${ext}`;
      const destPath = join(projectDir, safeName);
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
        await runner.prompt(prepareUserContent(ctx, promptText), buffer);
      } catch (err) {
        log.error("runner voice prompt failed", { error: String(err), sessionId: session.id });
      }
      return;
    }

    log.debug("dropping voice: no projectDir");
    await ctx.reply("No project directory is set. Use /project <path> to enable file saving.");
  });

  // Wire agent runner for audio messages (music files)
  bot.on("message:audio", async (ctx: Context) => {
    const locator = locatorFromCtx(ctx);
    if (!locator) {
      log.debug("dropping audio: no locator");
      return;
    }

    const isSupergroup = ctx.chat?.type === "supergroup";
    const session = manager.resolve(locator, { isSupergroup });
    if (!session) {
      if (locator.topicId === undefined) {
        ctx.reply("No active session. Use /new to start one.").catch((err: unknown) => {
          log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
        });
      }
      log.debug("dropping audio: no session", { chatId: locator.chatId, topicId: locator.topicId });
      return;
    }

    const audio = ctx.msg?.audio;
    if (!audio?.file_id) return;

    const runner = getOrCreateRunner(session, locator, ctx);
    const projectDir = manager.getProjectDir(locator);

    if (projectDir) {
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
      const destPath = join(projectDir, safeName);
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
        await runner.prompt(prepareUserContent(ctx, promptText), buffer);
      } catch (err) {
        log.error("runner audio prompt failed", { error: String(err), sessionId: session.id });
      }
      return;
    }

    log.debug("dropping audio: no projectDir");
    const fallbackCaption = ctx.msg?.caption;
    if (fallbackCaption) {
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
        await runner.prompt(prepareUserContent(ctx, fallbackCaption), buffer);
      } catch (err) {
        log.error("runner audio caption prompt failed", { error: String(err), sessionId: session.id });
      }
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
