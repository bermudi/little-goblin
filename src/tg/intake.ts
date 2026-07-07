import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Bot } from "grammy";
import type { InlineQueryResult } from "@grammyjs/types";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { AgentRunner, appendAssistantTranscriptEntry, ModelNotCapableError } from "../agent/mod.ts";
import { resolveModel, type ResolvedModel } from "../agent/models.ts";
import { handleCommand, type DispatchDeps } from "../commands/dispatch.ts";
import { parseCommand } from "../commands/parse.ts";
import { resolveCommand, resolveTiming, type SideEffect } from "../commands/registry.ts";
import { interruptAndCascade } from "../interrupt.ts";
import { MemoryStore } from "../memory/mod.ts";
import { SessionManager, type ChatLocator, type SessionState } from "../sessions/mod.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { TurnDispatcher, type PromptContent, type TurnSink } from "../orchestration/dispatcher.ts";
import { transcribeWithGroq } from "../asr/mod.ts";
import { MessageBuffer } from "./mod.ts";
import { GuestReplySink } from "./guest-sink.ts";
import { type ReplyOpts, sendSystemReply } from "./format.ts";
import type { ScheduleStore } from "../scheduler/store.ts";

export type { PromptContent };

export interface TelegramIntakeMessage {
  locator: ChatLocator | null;
  isSupergroup: boolean;
  threadId?: number;
  reply: (text: string, opts?: ReplyOpts) => Promise<void>;
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

/**
 * A guest summon: the foreign chat id and a one-shot reply callback that
 * encapsulates `ctx.answerGuestQuery`. `guest_query_id` lives entirely inside
 * the closure — the intake MUST NOT name, log, or persist it. See design D5.
 */
export interface GuestMessage {
  chatId: number;
  replyVia: (result: InlineQueryResult) => Promise<unknown>;
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
  /**
   * Optional override for the turn-sink factory. Production leaves this unset
   * and `createTelegramIntake` builds the default `MessageBuffer` factory
   * (Telegram rendering + the `onTopicNotFound` orphan-archive hook). Tests
   * inject a fake to observe sink creation without a real `MessageBuffer`.
   */
  createMessageBuffer?: (locator: ChatLocator) => TurnSink;
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
    sendSystemReply(message, "No active session. Use /new to start one.", "info").catch((err: unknown) => {
      log.error("failed to send session prompt", { error: String(err), chatId: locator.chatId });
    });
  }
  log.debug(`dropping ${kind}: no session`, { chatId: locator.chatId, topicId: locator.topicId });
}

export function createTelegramIntake(options: TelegramIntakeOptions) {
  const { cfg, bot, manager, subagentRunner, memoryStore } = options;
  // The turn-sink factory: builds a `MessageBuffer` targeting the Telegram
  // surface for a locator. This rendering logic lived inside the dispatcher
  // before relocation; it moves here (the Telegram layer) so the dispatcher
  // stays transport-agnostic. Tests override via `options.createMessageBuffer`.
  const createMessageBuffer = options.createMessageBuffer ?? ((locator: ChatLocator): TurnSink => {
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
  });
  const dispatcher = new TurnDispatcher({
    cfg,
    bot,
    manager,
    subagentRunner,
    memoryStore,
    agentRunners: options.agentRunners,
    promptQueues: options.promptQueues,
    createAgentRunner: options.createAgentRunner,
    createMessageBuffer,
  });

  function recordAssistantReply(sessionId: string, text: string): void {
    appendAssistantTranscriptEntry(sessionId, cfg.goblinHome, text);
  }

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
          await sendSystemReply(message, err.message, "error");
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
        const currentRunner = dispatcher.getRunner(session.id);
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
        if (result.kind === "replied") await sendSystemReply(message, result.reply, result.tag ?? "ok");
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("deferred command failed", { error: msg, command, sessionId: session.id });
        const replyText = `/${command} failed after the turn: ${msg}`;
        await sendSystemReply(message, replyText, "error").catch(() => {});
        recordAssistantReply(session.id, replyText);
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
              await sendSystemReply(message, err.message, "error");
              recordAssistantReply(session.id, err.message);
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
    const existingRunner = session ? dispatcher.getRunner(session.id) : null;
    const command = parseCommand(rawText);
    if (command !== null) {
      const def = resolveCommand(command);
      const timing = resolveTiming(def, rawText ?? "");

      // Queue-timing commands defer behind an in-flight turn so the runner is
      // idle when they mutate state (model switch, project rebind, archive,
      // compact, etc.). Interrupt-timing (/cancel) and instant-timing
      // commands run immediately regardless of streaming state.
      if (timing === "queue" && session && existingRunner?.isStreaming) {
        await sendSystemReply(message, "Queued. Will run after this turn.", "queued");
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
          await sendSystemReply(message, result.reply, result.tag ?? "ok");
          return;
        }
      } catch (err) {
        log.error("command dispatch failed", { error: String(err), command, sessionId: session?.id });
        await sendSystemReply(message, "Something went wrong. Please try again.", "error");
        if (session) recordAssistantReply(session.id, "Something went wrong. Please try again.");
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
          const replyText = "Sorry, I couldn't download that image.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, replyText);
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
            const replyText = "Sorry, I couldn't download that file.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
            return;
          }

          let safeName = basename(doc.fileName || "attachment").trim() || "attachment";
          if (safeName === "." || safeName === "..") {
            if (isCurrent()) {
              const replyText = "Rejected: unsafe filename.";
              await sendSystemReply(message, replyText, "warn");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }
          const destPath = join(turn.projectDir, safeName);
          if (!isCurrent()) return;
          try {
            await writeFile(destPath, raw);
          } catch (err) {
            log.error("failed to write attachment to project directory", { error: String(err), destPath });
            if (isCurrent()) {
              const replyText = `Failed to save ${safeName}.`;
              await sendSystemReply(message, replyText, "error");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }

          if (!isCurrent()) return;
          await sendSystemReply(message, `Saved ${safeName}.`, "ok");

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
          const replyText = "No project directory is set. Use /project <path> to enable file saving.";
          await sendSystemReply(message, replyText, "warn");
          recordAssistantReply(turn.session.id, replyText);
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
        // Groq ASR setup gate: missing key fails at use time with a clear
        // message rather than at startup. Checked inside the scheduled task so
        // the reply respects the stale-runner guard and stays non-blocking.
        if (!cfg.groqApiKey) {
          if (!isCurrent()) return;
          const replyText = "Groq ASR is not configured. Add a Groq API key to transcribe voice messages.";
          await sendSystemReply(message, replyText, "warn");
          recordAssistantReply(turn.session.id, replyText);
          return;
        }

        // One download serves both ASR and optional project-file saving, so a
        // failure here short-circuits before either side effect.
        const raw = await downloadFileBytes(api, voice.fileId, cfg.botToken);
        if (!isCurrent()) return;
        if (!raw) {
          if (isCurrent()) {
            const replyText = "Sorry, I couldn't download that voice message.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
          }
          return;
        }

        // Telegram voice messages are OGG Opus; default to audio/ogg when the
        // field is absent rather than rejecting the message.
        const mimeType = voice.mimeType ?? "audio/ogg";
        const asrResult = await transcribeWithGroq({
          audioBytes: raw,
          mimeType,
          model: cfg.asrModel ?? "whisper-large-v3-turbo",
          apiKey: cfg.groqApiKey,
        });
        if (!isCurrent()) return;

        if (!asrResult.ok) {
          // Transport/API failure only; the sanitized error carries no secrets.
          log.warn("voice transcription failed", { error: asrResult.error, sessionId: turn.session.id });
          if (isCurrent()) {
            const replyText = "Sorry, I couldn't transcribe that voice message.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
          }
          return;
        }

        // Intake owns the semantic empty-text check: a successful HTTP response
        // with no speech is not an ASR failure.
        if (asrResult.text.length === 0) {
          if (isCurrent()) {
            const replyText = "No speech was detected in that voice message.";
            await sendSystemReply(message, replyText, "info");
            recordAssistantReply(turn.session.id, replyText);
          }
          return;
        }

        // Transcription succeeded with text. Build the transcript prompt.
        let promptText = `[Voice message transcript]\n${asrResult.text}`;

        // Preserve the original voice-file saving behavior for project-bound
        // sessions and append a saved-file note alongside the transcript.
        // Saved-name mime→ext mapping is deliberately the narrow subset the spec
        // constrains (`audio/ogg → oga, else bin`); the ASR-side table in
        // groq.ts is liberal because Groq only uses it as a multipart hint.
        if (turn.projectDir) {
          const ext = mimeType === "audio/ogg" ? "oga" : "bin";
          const safeName = `voice-${Date.now()}.${ext}`;
          const destPath = join(turn.projectDir, safeName);
          if (!isCurrent()) return;
          try {
            await writeFile(destPath, raw);
          } catch (err) {
            // Save failure discards an otherwise-successful transcript: the user
            // just got a "Failed to save" reply, and prompting without the saved
            // file (which the transcript note promises) would be misleading.
            // Spec-silent; this preserves pre-ASR voice behavior.
            log.error("failed to write voice to project directory", { error: String(err), destPath });
            if (isCurrent()) {
              const replyText = `Failed to save ${safeName}.`;
              await sendSystemReply(message, replyText, "error");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }

          if (!isCurrent()) return;
          await sendSystemReply(message, `Saved ${safeName}.`, "ok");

          const escapedName = safeName.replace(/`/g, "'");
          promptText = `[Voice message transcript]\n${asrResult.text}\n\n[Voice file \`${escapedName}\` saved to project directory.]`;
        }

        if (!isCurrent()) return;
        await runPrompt(message, turn.locator, runner, promptText);
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
            const replyText = "Sorry, I couldn't download that audio file.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
            return;
          }

          let safeName = audio.fileName?.trim();
          if (!safeName) {
            const title = [audio.performer, audio.title].filter(Boolean).join(" - ");
            safeName = title ? `${title}.mp3` : `audio-${Date.now()}.mp3`;
          }
          safeName = basename(safeName);
          if (safeName === "." || safeName === "..") {
            if (isCurrent()) {
              const replyText = "Rejected: unsafe filename.";
              await sendSystemReply(message, replyText, "warn");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }
          const destPath = join(turn.projectDir, safeName);
          if (!isCurrent()) return;
          try {
            await writeFile(destPath, raw);
          } catch (err) {
            log.error("failed to write audio to project directory", { error: String(err), destPath });
            if (isCurrent()) {
              const replyText = `Failed to save ${safeName}.`;
              await sendSystemReply(message, replyText, "error");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }

          if (!isCurrent()) return;
          await sendSystemReply(message, `Saved ${safeName}.`, "ok");

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
          const replyText = "No project directory is set. Use /project <path> to enable file saving.";
          await sendSystemReply(message, replyText, "warn");
          recordAssistantReply(turn.session.id, replyText);
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

  /**
   * Handle a guest summon: resolve (auto-create) a guest session keyed on the
   * foreign chat id, run the agent to completion against a non-streaming sink,
   * and reply exactly once via `message.replyVia`. The `text` arrives already
   * mention-stripped and sender-prefixed from the bot.ts adapter.
   *
   * The `guest_query_id` lives inside `replyVia`'s closure (built by the
   * adapter as `(result) => ctx.answerGuestQuery(result)`); this function never
   * names or extracts it. `replyVia` is single-use and short-lived — if the
   * runner is busy we reply immediately with a busy fallback so the id is
   * consumed before expiry rather than queueing a turn that would outlive it.
   * If `replyVia` itself rejects (expired id), the rejection is swallowed: the
   * summoner sees nothing, but the bot does not crash.
   */
  async function handleGuestMessage(message: GuestMessage, text: string): Promise<void> {
    const locator: ChatLocator = { chatId: message.chatId };
    const session = manager.resolve(locator, { isGuest: true });
    // resolve({ isGuest }) auto-creates like topics/supergroups, so null is
    // unreachable in practice. Fail loud if it ever returns null.
    if (!session) {
      log.error("guest resolve returned null despite auto-create", { chatId: message.chatId });
      try {
        await message.replyVia(errorArticle());
      } catch (err) {
        log.warn("guest error reply failed", { error: String(err), chatId: message.chatId });
      }
      return;
    }
    const runner = dispatcher.getOrCreateRunner(session, locator);

    // Busy path: never queue. guest_query_id would expire before a queued turn
    // runs, so reply immediately with a busy fallback to consume the id.
    if (runner.isStreaming) {
      log.debug("guest summon dropped: runner busy", { chatId: message.chatId, sessionId: session.id });
      try {
        await message.replyVia(busyArticle());
      } catch (err) {
        log.warn("guest busy reply failed", { error: String(err), chatId: message.chatId });
      }
      return;
    }

    const sink = new GuestReplySink();
    try {
      await runner.prompt(text, sink);
    } catch (err) {
      log.warn("guest turn failed", { error: String(err), chatId: message.chatId, sessionId: session.id });
      try {
        await message.replyVia(errorArticle());
      } catch (replyErr) {
        log.warn("guest error reply failed", { error: String(replyErr), chatId: message.chatId });
      }
      return;
    }

    try {
      await message.replyVia(article(sink.text || "(no response)"));
    } catch (err) {
      // Expired guest_query_id or other Telegram failure — swallow so the bot
      // does not crash. The summoner sees nothing; inherent to the one-shot API.
      log.warn("guest reply failed", { error: String(err), chatId: message.chatId });
    }
  }

  return {
    handleText,
    handlePhoto,
    handleDocument,
    handleVoice,
    handleAudio,
    handleTopicDescription,
    handleGuestMessage,
    dispatcher,
  };
}

/** Build a single-shot `InlineQueryResultArticle` carrying plain text. */
function article(messageText: string): InlineQueryResult {
  return {
    type: "article",
    id: randomUUID(),
    title: "Goblin",
    input_message_content: { message_text: messageText },
  };
}

function busyArticle(): InlineQueryResult {
  return article("⏳ I'm already thinking about something — try again in a moment.");
}

function errorArticle(): InlineQueryResult {
  return article("⚠️ Something went wrong.");
}
