import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Bot } from "grammy";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { AgentRunner, ModelNotCapableError } from "../agent/mod.ts";
import { resolveModel, type ResolvedModel } from "../agent/models.ts";
import { handleCommand, type DispatchDeps } from "../commands/dispatch.ts";
import { parseCommand } from "../commands/parse.ts";
import { resolveCommand, resolveTiming, type SideEffect } from "../commands/registry.ts";
import { interruptAndCascade } from "../interrupt.ts";
import { MemoryStore } from "../memory/mod.ts";
import { SessionManager, type ChatLocator, type SessionState } from "../sessions/mod.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { TurnDispatcher, type PromptContent } from "./turn-dispatcher.ts";
import type { MessageBuffer } from "./mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";

export type { PromptContent };

export interface TelegramIntakeMessage {
  locator: ChatLocator | null;
  isSupergroup: boolean;
  threadId?: number;
  reply: (text: string) => Promise<void>;
  prepare: (content: PromptContent) => PromptContent;
}

export interface TelegramDocumentInput {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

export interface TelegramVoiceInput {
  fileId: string;
  mimeType?: string;
}

export interface TelegramAudioInput {
  fileId: string;
  fileName?: string;
  performer?: string;
  title?: string;
  caption?: string;
}

export interface TelegramIntakeOptions {
  cfg: Config;
  bot: Bot;
  manager: SessionManager;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  agentRunners: Map<string, AgentRunner>;
  promptQueues?: Map<string, Promise<void>>;
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  createMessageBuffer?: (locator: ChatLocator) => MessageBuffer;
  /** Shared schedule store for `/schedule`. Wired in Phase 6 (bot.ts). */
  scheduleStore?: ScheduleStore;
}

type ActiveTurn = {
  locator: ChatLocator;
  session: SessionState;
  projectDir: string | undefined;
  schedule: (
    run: (runner: AgentRunner, isCurrent: () => boolean) => Promise<void>,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ) => void;
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function downloadFileBytes(
  api: Bot["api"],
  fileId: string,
  botToken: string,
): Promise<Uint8Array | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) return null;

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
    log.warn("failed to download file", { fileId, code: (err as { code?: string }).code });
    return null;
  }
}

async function downloadFile(
  api: Bot["api"],
  fileId: string,
  botToken: string,
  mimeType = "image/jpeg",
): Promise<{ data: string; mimeType: string } | null> {
  const raw = await downloadFileBytes(api, fileId, botToken);
  if (!raw) return null;

  const CHUNK = 48 * 1024;
  let data = "";
  for (let i = 0; i < raw.length; i += CHUNK) {
    const slice = raw.subarray(i, i + CHUNK);
    data += btoa(String.fromCharCode(...slice));
  }
  return { data, mimeType };
}

async function downloadPhoto(
  api: Bot["api"],
  fileIds: string[],
  botToken: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (fileIds.length === 0) return null;
  const largest = fileIds[fileIds.length - 1]!;
  return downloadFile(api, largest, botToken);
}

export function replyNoActiveSession(message: TelegramIntakeMessage, locator: ChatLocator, kind: string): void {
  if (locator.topicId === undefined) {
    message.reply("No active session. Use /new to start one.").catch((err: unknown) => {
      log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
    });
  }
  log.debug(`dropping ${kind}: no session`, { chatId: locator.chatId, topicId: locator.topicId });
}

export function createTelegramIntake(options: TelegramIntakeOptions) {
  const { cfg, bot, manager, subagentRunner, memoryStore } = options;
  const dispatcher = new TurnDispatcher({
    cfg,
    bot,
    manager,
    subagentRunner,
    memoryStore,
    agentRunners: options.agentRunners,
    promptQueues: options.promptQueues,
    createAgentRunner: options.createAgentRunner,
    createMessageBuffer: options.createMessageBuffer,
  });

  function tryResolveModel(cfg: Config, session: SessionState | null, runner?: AgentRunner): ResolvedModel | undefined {
    try {
      const modelName = runner?.modelName ?? session?.modelName ?? cfg.modelName;
      return resolveModel({ ...cfg, modelName });
    } catch {
      return undefined;
    }
  }

  function scheduleFreshTurn(
    message: TelegramIntakeMessage,
    locator: ChatLocator,
    session: SessionState,
    runner: AgentRunner,
    content: PromptContent,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ): void {
    const buffer = dispatcher.createMessageBuffer(locator);
    dispatcher.schedulePrompt(
      session,
      runner,
      async (isCurrent) => {
        if (!isCurrent()) return;
        await runner.prompt(message.prepare(content), buffer);
      },
      async (err) => {
        if (opts?.replyModelNotCapable && err instanceof ModelNotCapableError) {
          await message.reply(`❌ ${err.message}`);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.error(failureLog, { error: msg, sessionId: session.id });
      },
    );
  }

  /**
   * Apply the side effects returned by `handleCommand`. Shared between the
   * immediate-dispatch path and the deferred (queued-behind-turn) path so the
   * semantics stay identical: create runners, dispose runners (severing their
   * prompt queue chain), or enqueue a fresh prompt.
   */
  function applySideEffects(sideEffects: SideEffect[], message: TelegramIntakeMessage, locator: ChatLocator): void {
    for (const effect of sideEffects) {
      if (effect.kind === "runner-created") {
        dispatcher.setRunner(effect.session, effect.locator, message.threadId);
      } else if (effect.kind === "runner-disposed") {
        dispatcher.disposeRunner(effect.sessionId);
      } else if (effect.kind === "queue-prompt") {
        const queueRunner = dispatcher.getOrCreateRunner(effect.session, locator, message.threadId);
        scheduleFreshTurn(message, locator, effect.session, queueRunner, effect.text, "queued prompt failed");
      }
    }
  }

  /**
   * Defer a state-mutating command behind the current turn. Hooks into the
   * same per-session `schedulePrompt` chain that serializes prompts, so the
   * command runs strictly after the in-flight turn settles (success or error)
   * and the runner is idle. The user has already received an instant "Queued."
   * ack; this re-dispatches the command once idle and sends the follow-up reply.
   *
   * The `isCurrent()` staleness gate makes this a no-op if the runner gets
   * swapped (e.g. by a `/new` arriving mid-turn) before the deferred work runs.
   */
  function scheduleDeferredCommand(
    message: TelegramIntakeMessage,
    locator: ChatLocator,
    session: SessionState,
    runner: AgentRunner,
    rawText: string,
    command: string,
  ): void {
    dispatcher.schedulePrompt(
      session,
      runner,
      async (isCurrent) => {
        if (!isCurrent()) return;
        // Re-resolve the runner: a queued `/new` or `/resume` in the same
        // chain may have swapped it. If it's gone, the turn's session is no
        // longer bound here, so drop the deferred command.
        const currentRunner = dispatcher.runners.get(session.id);
        if (!currentRunner) return;
        const result = await handleCommand({
          command,
          deps: dispatchDeps,
          rawText,
          locator,
          isSupergroup: message.isSupergroup,
          session,
          existingRunner: currentRunner,
          bot,
        });
        if (!isCurrent()) return;
        // Queue-timing commands always have a handler, so fallthrough is
        // impossible here — but narrow for the typechecker regardless.
        if (result.kind === "fallthrough") return;
        applySideEffects(result.sideEffects, message, locator);
        if (result.kind === "replied") await message.reply(result.reply);
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("deferred command failed", { error: msg, command, sessionId: session.id });
        await message.reply(`/${command} failed after the turn: ${msg}`).catch(() => {});
      },
    );
  }

  function steerOrFallbackToFreshTurn(
    message: TelegramIntakeMessage,
    locator: ChatLocator,
    session: SessionState,
    runner: AgentRunner,
    text: string,
  ): void {
    void runner.followUp(message.prepare(text)).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not streaming")) {
        scheduleFreshTurn(message, locator, session, runner, text, "runner prompt failed (steer race fallback)");
        return;
      }
      log.warn("steer failed", { error: msg, sessionId: session.id });
    });
  }

  function resolveActiveTurn(message: TelegramIntakeMessage, kind: string): ActiveTurn | null {
    const locator = message.locator;
    if (!locator) {
      log.debug(`dropping ${kind}: no locator`);
      return null;
    }

    const session = manager.resolve(locator, { isSupergroup: message.isSupergroup });
    if (!session) {
      replyNoActiveSession(message, locator, kind);
      return null;
    }

    return {
      locator,
      session,
      projectDir: manager.getProjectDir(locator),
      schedule: (run, failureLog, opts) => {
        const runner = dispatcher.getOrCreateRunner(session, locator, message.threadId);
        dispatcher.schedulePrompt(
          session,
          runner,
          async (isCurrent) => {
            await run(runner, isCurrent);
          },
          async (err) => {
            if (opts?.replyModelNotCapable && err instanceof ModelNotCapableError) {
              await message.reply(`❌ ${err.message}`);
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            log.error(failureLog, { error: msg, sessionId: session.id });
          },
        );
      },
    };
  }

  const dispatchDeps: DispatchDeps = {
    manager,
    subagentRunner,
    cfg,
    tryResolveModel,
    interruptAndCascade,
    scheduleStore: options.scheduleStore,
  };

  async function runPrompt(message: TelegramIntakeMessage, locator: ChatLocator, runner: AgentRunner, content: PromptContent): Promise<void> {
    const buffer = dispatcher.createMessageBuffer(locator);
    await runner.prompt(message.prepare(content), buffer);
  }

  async function handleText(message: TelegramIntakeMessage, rawText: string | undefined): Promise<void> {
    const locator = message.locator;
    if (!locator) {
      log.debug("dropping message: no locator");
      return;
    }

    const session = manager.resolve(locator, { isSupergroup: message.isSupergroup });
    const existingRunner = session ? dispatcher.runners.get(session.id) ?? null : null;
    const command = parseCommand(rawText);
    if (command !== null) {
      const def = resolveCommand(command);
      const timing = resolveTiming(def, rawText ?? "");

      // Queue-timing commands defer behind an in-flight turn so the runner is
      // idle when they mutate state (model switch, project rebind, archive,
      // compact, etc.). Interrupt-timing (/cancel) and instant-timing
      // commands run immediately regardless of streaming state.
      if (timing === "queue" && session && existingRunner?.isStreaming) {
        await message.reply("Queued. Will run after this turn.");
        scheduleDeferredCommand(message, locator, session, existingRunner, rawText ?? "", command);
        return;
      }

      try {
        const result = await handleCommand({
          command,
          deps: dispatchDeps,
          rawText: rawText ?? "",
          locator,
          isSupergroup: message.isSupergroup,
          session,
          existingRunner,
          bot,
        });
        if (result.kind !== "fallthrough") {
          applySideEffects(result.sideEffects, message, locator);
          if (result.kind === "handled") return;
          await message.reply(result.reply);
          return;
        }
      } catch (err) {
        log.error("command dispatch failed", { error: String(err), command, sessionId: session?.id });
        await message.reply("Something went wrong. Please try again.");
        return;
      }
    }

    if (!session) {
      replyNoActiveSession(message, locator, "message");
      return;
    }

    const runner = dispatcher.getOrCreateRunner(session, locator, message.threadId);
    if (!rawText) return;

    if (runner.isStreaming) {
      steerOrFallbackToFreshTurn(message, locator, session, runner, rawText);
      return;
    }

    scheduleFreshTurn(message, locator, session, runner, rawText, "runner prompt failed");
  }

  async function handlePhoto(message: TelegramIntakeMessage, api: Bot["api"], fileIds: string[], caption?: string): Promise<void> {
    const turn = resolveActiveTurn(message, "photo");
    if (!turn) return;

    turn.schedule(
      async (runner, isCurrent) => {
        const photo = await downloadPhoto(api, fileIds, cfg.botToken);
        if (!isCurrent()) return;
        if (!photo) {
          await message.reply("Sorry, I couldn't download that image.");
          return;
        }

        const content: (TextContent | ImageContent)[] = [];
        if (caption) {
          content.push({ type: "text", text: caption });
        }
        content.push({ type: "image", data: photo.data, mimeType: photo.mimeType });

        if (!isCurrent()) return;
        await runPrompt(message, turn.locator, runner, content);
      },
      "runner photo prompt failed",
      { replyModelNotCapable: true },
    );
  }

  async function handleDocument(message: TelegramIntakeMessage, api: Bot["api"], doc: TelegramDocumentInput): Promise<void> {
    const turn = resolveActiveTurn(message, "document");
    if (!turn) return;

    turn.schedule(
      async (runner, isCurrent) => {
        if (turn.projectDir) {
          const raw = await downloadFileBytes(api, doc.fileId, cfg.botToken);
          if (!isCurrent()) return;
          if (!raw) {
            await message.reply("Sorry, I couldn't download that file.");
            return;
          }

          let safeName = basename(doc.fileName || "attachment").trim() || "attachment";
          if (safeName === "." || safeName === "..") {
            if (isCurrent()) await message.reply("Rejected: unsafe filename.");
            return;
          }
          const destPath = join(turn.projectDir, safeName);
          if (!isCurrent()) return;
          try {
            await writeFile(destPath, raw);
          } catch (err) {
            log.error("failed to write attachment to project directory", { error: String(err), destPath });
            if (isCurrent()) await message.reply(`Failed to save ${safeName}.`);
            return;
          }

          if (!isCurrent()) return;
          await message.reply(`Saved ${safeName}.`);

          const escapedName = safeName.replace(/`/g, "'");
          const promptText = doc.caption
            ? `${doc.caption}\n\n[File \`${escapedName}\` saved to project directory.]`
            : `User uploaded \`${escapedName}\` to the project directory.`;

          if (!isCurrent()) return;
          await runPrompt(message, turn.locator, runner, promptText);
          return;
        }

        if (!isCurrent()) return;
        log.debug("dropping document: no projectDir", { mimeType: doc.mimeType, fileName: doc.fileName });
        if (doc.caption) {
          await runPrompt(message, turn.locator, runner, doc.caption);
        } else {
          await message.reply("No project directory is set. Use /project <path> to enable file saving.");
        }
      },
      "runner document prompt failed",
    );
  }

  async function handleVoice(message: TelegramIntakeMessage, api: Bot["api"], voice: TelegramVoiceInput): Promise<void> {
    const turn = resolveActiveTurn(message, "voice");
    if (!turn) return;

    turn.schedule(
      async (runner, isCurrent) => {
        if (turn.projectDir) {
          const raw = await downloadFileBytes(api, voice.fileId, cfg.botToken);
          if (!isCurrent()) return;
          if (!raw) {
            await message.reply("Sorry, I couldn't download that voice message.");
            return;
          }

          const ext = voice.mimeType === "audio/ogg" ? "oga" : "bin";
          const safeName = `voice-${Date.now()}.${ext}`;
          const destPath = join(turn.projectDir, safeName);
          if (!isCurrent()) return;
          try {
            await writeFile(destPath, raw);
          } catch (err) {
            log.error("failed to write voice to project directory", { error: String(err), destPath });
            if (isCurrent()) await message.reply(`Failed to save ${safeName}.`);
            return;
          }

          if (!isCurrent()) return;
          await message.reply(`Saved ${safeName}.`);

          const escapedName = safeName.replace(/`/g, "'");
          const promptText = `User sent a voice message: \`${escapedName}\` saved to project directory.`;

          if (!isCurrent()) return;
          await runPrompt(message, turn.locator, runner, promptText);
          return;
        }

        if (!isCurrent()) return;
        log.debug("dropping voice: no projectDir");
        await message.reply("No project directory is set. Use /project <path> to enable file saving.");
      },
      "runner voice prompt failed",
    );
  }

  async function handleAudio(message: TelegramIntakeMessage, api: Bot["api"], audio: TelegramAudioInput): Promise<void> {
    const turn = resolveActiveTurn(message, "audio");
    if (!turn) return;

    turn.schedule(
      async (runner, isCurrent) => {
        if (turn.projectDir) {
          const raw = await downloadFileBytes(api, audio.fileId, cfg.botToken);
          if (!isCurrent()) return;
          if (!raw) {
            await message.reply("Sorry, I couldn't download that audio file.");
            return;
          }

          let safeName = audio.fileName?.trim();
          if (!safeName) {
            const title = [audio.performer, audio.title].filter(Boolean).join(" - ");
            safeName = title ? `${title}.mp3` : `audio-${Date.now()}.mp3`;
          }
          safeName = basename(safeName);
          if (safeName === "." || safeName === "..") {
            if (isCurrent()) await message.reply("Rejected: unsafe filename.");
            return;
          }
          const destPath = join(turn.projectDir, safeName);
          if (!isCurrent()) return;
          try {
            await writeFile(destPath, raw);
          } catch (err) {
            log.error("failed to write audio to project directory", { error: String(err), destPath });
            if (isCurrent()) await message.reply(`Failed to save ${safeName}.`);
            return;
          }

          if (!isCurrent()) return;
          await message.reply(`Saved ${safeName}.`);

          const escapedName = safeName.replace(/`/g, "'");
          const promptText = audio.caption
            ? `${audio.caption}\n\n[Audio file \`${escapedName}\` saved to project directory.]`
            : `User uploaded audio \`${escapedName}\` to the project directory.`;

          if (!isCurrent()) return;
          await runPrompt(message, turn.locator, runner, promptText);
          return;
        }

        if (!isCurrent()) return;
        log.debug("dropping audio: no projectDir");
        if (audio.caption) {
          await runPrompt(message, turn.locator, runner, audio.caption);
        } else {
          await message.reply("No project directory is set. Use /project <path> to enable file saving.");
        }
      },
      "runner audio prompt failed",
    );
  }

  async function handleTopicDescription(chatId: number | undefined, topicId: number | undefined, name: string | undefined): Promise<void> {
    if (chatId === undefined || topicId === undefined || name === undefined) return;
    try {
      await memoryStore.setDescription(
        { topic: { chatId, topicId } },
        name,
      );
    } catch {
    }
  }

  return {
    handleText,
    handlePhoto,
    handleDocument,
    handleVoice,
    handleAudio,
    handleTopicDescription,
    dispatcher,
  };
}
