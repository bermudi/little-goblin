import { randomUUID } from "node:crypto";
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
import { MemoryStore, EmbeddingProvider, DreamingPipeline } from "../memory/mod.ts";
import { MetricsStore } from "../metrics/mod.ts";
import {
  ConversationStore,
  type SessionState,
  runtimeSessionWithPreferences,
  type ConversationState,
} from "../sessions/mod.ts";
import { surfaceId, type Surface, type GuestSurface } from "../surface.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { saveAttachment, UnsafeAttachmentNameError, type SavedAttachment } from "./attachments.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { TurnDispatcher, type PromptContent, type TurnSink, type SurfaceSettings } from "../orchestration/dispatcher.ts";
import { createConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { createTurnDispatcherRuntimeHost } from "../orchestration/conversation-runtime-host.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import { getProjectRoot } from "../sessions/topic-settings.ts";
import { environmentFromProjectRoot } from "../sessions/environment.ts";
import { transcribeWithGroq } from "../asr/mod.ts";
import { MessageBuffer, createTextToSpeechTool } from "./mod.ts";
import { createSendDocumentTool, createSendPhotoTool, createSendVoiceTool } from "./tools.ts";
import { isPrivateChat } from "./delivery.ts";
import { GuestReplySink } from "./guest-sink.ts";
import { type ReplyOpts, sendSystemReply } from "./format.ts";
import type { ScheduleStore } from "../scheduler/store.ts";

export type { PromptContent };

export interface TelegramIntakeMessage {
  surface: Surface | null;
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
 * A guest summon: a validated guest Surface and a one-shot reply callback that
 * encapsulates `ctx.answerGuestQuery`. `guest_query_id` lives entirely inside
 * the closure — the intake MUST NOT name, log, or persist it. See design D5.
 */
export interface GuestMessage {
  surface: GuestSurface;
  replyVia: (result: InlineQueryResult) => Promise<unknown>;
}

export interface TelegramIntakeOptions {
  cfg: Config;
  bot: Bot;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  agentRunners: Map<string, AgentRunner>;
  promptQueues?: Map<string, Promise<void>>;
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  /** Shared embedding provider for agent memory stores. */
  embeddingProvider?: EmbeddingProvider;
  /** Shared dreaming pipeline for background memory promotion. */
  dreamingPipeline?: DreamingPipeline;
  /**
   * Optional override for the turn-sink factory. Production leaves this unset
   * and `createTelegramIntake` builds the default `MessageBuffer` factory
   * (Telegram rendering + the `onTopicNotFound` orphan-archive hook). Tests
   * inject a fake to observe sink creation without a real `MessageBuffer`.
   */
  createMessageBuffer?: (surface: Surface, session?: SessionState) => TurnSink;
  /** Shared schedule store for `/schedule`. Wired in Phase 6 (bot.ts). */
  scheduleStore?: ScheduleStore;
  /** Shared external agent runner. Wired in Phase 6 (bot.ts). */
  externalAgentRunner?: ExternalAgentRunner;
  /** Shared MCP runner. Wired in buildBot. */
  mcpRunner?: McpRunner;
}

type ActiveTurn = {
  surface: Surface;
  session: SessionState;
  environment: ExecutionEnvironment;
  schedule: (
    run: (runner: AgentRunner, isCurrent: () => boolean) => Promise<void>,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ) => Promise<void>;
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

export function replyNoActiveSession(message: TelegramIntakeMessage, surface: Surface, kind: string): void {
  if (surface.kind === "dm") {
    sendSystemReply(message, "No active conversation. Use /new to start one.", "info").catch((err: unknown) => {
      log.error("failed to send conversation prompt", { error: String(err), surfaceId: surfaceId(surface) });
    });
  }
  log.debug(`dropping ${kind}: no conversation`, { surfaceId: surfaceId(surface) });
}

export function createTelegramIntake(options: TelegramIntakeOptions) {
  const { cfg, bot, subagentRunner, memoryStore, embeddingProvider, dreamingPipeline } = options;
  // The turn-sink factory: builds a `MessageBuffer` targeting the Telegram
  // surface for a surface. This rendering logic lived inside the dispatcher
  // before relocation; it moves here (the Telegram layer) so the dispatcher
  // stays transport-agnostic. Tests override via `options.createMessageBuffer`.
  const createMessageBuffer = options.createMessageBuffer ?? ((surface: Surface, session?: SessionState): TurnSink => {
    const metrics = session ? new MetricsStore(cfg.goblinHome, session.id) : undefined;
    return new MessageBuffer(bot, surface, {
      visibility: cfg.toolVisibility,
      metrics,
      drafts: isPrivateChat(surface),
      onTopicNotFound:
        surface.kind === "topic"
          ? async () => {
              await memoryStore.archiveOrphan(surface.chatId, surface.topicId);
            }
          : undefined,
    });
  });
  // Beta tool factory: builds the Telegram-specific tools (voice, photo,
  // document, TTS) for a chat. The dispatcher does not import from `src/tg/`;
  // this factory is injected so the Telegram layer owns beta tool creation.
  const createBetaTools = (surface: Surface) => {
    if (surface.kind === "guest") {
      // Guest surfaces do not support normal chat send methods.
      return [createTextToSpeechTool()];
    }
    return [
      createSendVoiceTool(bot, surface),
      createSendPhotoTool(bot, surface),
      createSendDocumentTool(bot, surface),
      createTextToSpeechTool(),
    ].filter((t): t is NonNullable<typeof t> => t !== null);
  };
  const surfaceSettings: SurfaceSettings = {
    effectiveEnvironment: (surface) => environmentFromProjectRoot(getProjectRoot(cfg.goblinHome, surface)),
  };

  const dispatcher = new TurnDispatcher({
    cfg,
    surfaceSettings,
    subagentRunner,
    memoryStore,
    agentRunners: options.agentRunners,
    promptQueues: options.promptQueues,
    createAgentRunner: options.createAgentRunner,
    createMessageBuffer,
    createBetaTools,
    scheduleStore: options.scheduleStore,
    externalAgentRunner: options.externalAgentRunner,
    mcpRunner: options.mcpRunner,
    embeddingProvider,
    dreamingPipeline,
  });

  // Build the deep conversation lifecycle around the same dispatcher so all
  // runtime invalidation and quiescence is shared between Telegram intake and
  // the lifecycle operations called by commands / scheduler.
  const lifecycle = createConversationLifecycle(cfg.goblinHome, createTurnDispatcherRuntimeHost(dispatcher));

  // Wire the binding inspector so the dispatcher can recheck binding authority
  // after memory capture. This catches stale callers whose binding was rotated
  // (e.g. by /new) before their creation started — a case the dispatcher's
  // in-flight identity check alone cannot detect.
  dispatcher.setBindingInspector((surface) => lifecycle.inspect(surface)?.id);

  function recordAssistantReply(sessionId: string, text: string): void {
    appendAssistantTranscriptEntry(sessionId, cfg.goblinHome, text);
  }

  const WEDGED_RUNNER_REPLY =
    "A previous turn is wedged after a failed abort. Use /new or /archive to recover.";

  function tryResolveModel(cfg: Config, modelName: string): ResolvedModel | undefined {
    try {
      return resolveModel({ ...cfg, modelName });
    } catch {
      return undefined;
    }
  }

  function scheduleFreshTurn(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: SessionState,
    runner: AgentRunner,
    content: PromptContent,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ): void {
    const buffer = dispatcher.createMessageBuffer(surface, session);
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
  async function applySideEffects(sideEffects: SideEffect[], message: TelegramIntakeMessage, surface: Surface): Promise<void> {
    for (const effect of sideEffects) {
      if (effect.kind === "runner-created") {
        await dispatcher.getOrCreateRunner(effect.session, effect.surface);
      } else if (effect.kind === "runner-disposed") {
        await dispatcher.disposeRunner(effect.sessionId);
      } else if (effect.kind === "queue-prompt") {
        const queueRunner = await dispatcher.getOrCreateRunner(effect.session, surface);
        scheduleFreshTurn(message, surface, effect.session, queueRunner, effect.text, "queued prompt failed");
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
    surface: Surface,
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
          surface,

          session,
          existingRunner: currentRunner,
          bot,
        });
        // Queue-timing commands always have a handler, so fallthrough is
        // impossible here — but narrow for the typechecker regardless.
        if (result.kind === "fallthrough") return;
        await applySideEffects(result.sideEffects, message, surface);
        if (result.kind === "replied") await sendSystemReply(message, result.reply, result.tag ?? "ok");
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("deferred command failed", { error: msg, command, sessionId: session.id });
        const replyText = `/${command} failed after the turn: ${msg}`;
        await sendSystemReply(message, replyText, "error").catch(() => {});
        recordAssistantReply(session.id, replyText);
      },
      { isPrompt: false },
    );
  }

  function steerOrFallbackToFreshTurn(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: SessionState,
    runner: AgentRunner,
    text: string,
  ): void {
    void runner.followUp(message.prepare(text)).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not streaming")) {
        scheduleFreshTurn(message, surface, session, runner, text, "runner prompt failed (steer race fallback)");
        return;
      }
      log.warn("steer failed", { error: msg, sessionId: session.id });
    });
  }

  async function resolveActiveTurn(message: TelegramIntakeMessage, kind: string): Promise<ActiveTurn | null> {
    const surface = message.surface;
    if (!surface) {
      log.debug(`dropping ${kind}: no surface`);
      return null;
    }

    // Photos, documents, voice, and audio are ordinary authorized content:
    // lazily create a conversation on the surface, just like text.
    let conversation: ConversationState;
    try {
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (err) {
      log.error(`failed to resolve ${kind}`, { error: String(err), surfaceId: surfaceId(surface) });
      return null;
    }
    const session = runtimeSessionWithPreferences(conversation, surface, cfg.goblinHome);

    return {
      surface,
      session,
      environment: conversation.executionEnvironment,
      schedule: async (run, failureLog, opts) => {
        const runner = await dispatcher.getOrCreateRunner(session, surface);
        if (runner.isAbortTimedOut) {
          sendSystemReply(message, WEDGED_RUNNER_REPLY, "error").catch((err: unknown) => {
            log.error("failed to send wedged runner reply", {
              error: String(err),
              sessionId: session.id,
            });
          });
          return;
        }
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
    lifecycle,
    conversationStore: new ConversationStore(cfg.goblinHome),
    subagentRunner,
    cfg,
    tryResolveModel,
    interruptAndCascade,
    scheduleStore: options.scheduleStore,
    dispatcher,
    externalAgentRunner: options.externalAgentRunner,
  };

  async function runPrompt(message: TelegramIntakeMessage, surface: Surface, runner: AgentRunner, session: SessionState, content: PromptContent): Promise<void> {
    const buffer = dispatcher.createMessageBuffer(surface, session);
    await runner.prompt(message.prepare(content), buffer);
  }

  async function handleText(message: TelegramIntakeMessage, rawText: string | undefined): Promise<void> {
    const surface = message.surface;
    if (!surface) {
      log.debug("dropping message: no surface");
      return;
    }

    const command = parseCommand(rawText);
    const def = command !== null ? resolveCommand(command) : null;
    // Avoid creating a conversation for unknown slash commands when no
    // conversation is bound. Plain text, /new, and known commands are each
    // responsible for their own behavior.
    const existingConversation = lifecycle.inspect(surface);
    if (!existingConversation && command !== null && command !== "/new" && def === null) {
      if (surface.kind !== "guest") {
        replyNoActiveSession(message, surface, "text");
      }
      return;
    }

    if (command !== null) {
      // Commands, status reads, and scheduler-related interactions inspect the
      // current binding without creating history.
      const session = existingConversation ? runtimeSessionWithPreferences(existingConversation, surface, cfg.goblinHome) : null;
      const existingRunner = session ? dispatcher.getRunner(session.id) : null;
      const timing = resolveTiming(def, rawText ?? "");

      // Queue-timing commands defer behind an in-flight turn so the runner is
      // idle when they mutate state (model switch, project rebind, archive,
      // compact, etc.). They also defer behind a prompt that has already started
      // (isPrompting), e.g. a coalescer-flushed prompt whose handleText has
      // already called runner.prompt, and behind any already-deferred command.
      // Interrupt-timing (/cancel) and instant-timing commands run immediately.
      const busy =
        existingRunner?.isStreaming ||
        existingRunner?.isPrompting ||
        (session ? dispatcher.isCommandPending(session.id) : false);
      if (timing === "queue" && session && busy) {
        await sendSystemReply(message, "Queued. Will run after this turn.", "queued");
        const queueRunner = existingRunner ?? await dispatcher.getOrCreateRunner(session, surface);
        scheduleDeferredCommand(message, surface, session, queueRunner, rawText ?? "", command);
        return;
      }

      try {
        const result = await handleCommand({
          command,
          deps: dispatchDeps,
          rawText: rawText ?? "",
          surface,

          session,
          existingRunner,
          bot,
        });
        if (result.kind !== "fallthrough") {
          await applySideEffects(result.sideEffects, message, surface);
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

    // Ordinary authorized content lazily creates a conversation on any supported
    // surface, including DMs and guest text.
    const conversation = await lifecycle.resolveOrStart(surface);
    const session = runtimeSessionWithPreferences(conversation, surface, cfg.goblinHome);

    const runner = await dispatcher.getOrCreateRunner(session, surface);
    if (!rawText) return;

    if (runner.isAbortTimedOut) {
      await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
      return;
    }

    if (runner.isStreaming) {
      steerOrFallbackToFreshTurn(message, surface, session, runner, rawText);
      return;
    }

    scheduleFreshTurn(message, surface, session, runner, rawText, "runner prompt failed");
  }

  async function handlePhoto(message: TelegramIntakeMessage, api: Bot["api"], fileIds: string[], caption?: string): Promise<void> {
    const turn = await resolveActiveTurn(message, "photo");
    if (!turn) return;

    await turn.schedule(
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
        await runPrompt(message, turn.surface, runner, turn.session, content);
      },
      "runner photo prompt failed",
      { replyModelNotCapable: true },
    );
  }

  async function handleDocument(message: TelegramIntakeMessage, api: Bot["api"], doc: TelegramDocumentInput): Promise<void> {
    const turn = await resolveActiveTurn(message, "document");
    if (!turn) return;

    await turn.schedule(
      async (runner, isCurrent) => {
        const raw = await downloadFileBytes(api, doc.fileId, cfg.botToken);
        if (!isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, replyText);
          return;
        }

        const desiredName = doc.fileName || "attachment";
        let saved: SavedAttachment;
        try {
          if (!isCurrent()) return;
          saved = saveAttachment(turn.environment, cfg.goblinHome, desiredName, raw);
        } catch (err) {
          if (err instanceof UnsafeAttachmentNameError) {
            const replyText = "Rejected: unsafe filename.";
            if (isCurrent()) {
              await sendSystemReply(message, replyText, "warn");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }
          log.error("failed to save document attachment", {
            error: err instanceof Error ? err.message : String(err),
            fileName: desiredName,
            sessionId: turn.session.id,
          });
          if (isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
          }
          return;
        }

        if (!isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = doc.caption
          ? `${doc.caption}\n\n[File \`${escapedPath}\` saved.]`
          : `User uploaded \`${escapedPath}\`.`;

        if (!isCurrent()) return;
        await runPrompt(message, turn.surface, runner, turn.session, promptText);
      },
      "runner document prompt failed",
    );
  }

  async function handleVoice(message: TelegramIntakeMessage, api: Bot["api"], voice: TelegramVoiceInput): Promise<void> {
    const turn = await resolveActiveTurn(message, "voice");
    if (!turn) return;

    await turn.schedule(
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

        // Transcription succeeded with text. Save the original voice file and
        // append a saved-file note alongside the transcript.
        const ext = mimeType === "audio/ogg" ? "oga" : "bin";
        const desiredName = `voice-${Date.now()}.${ext}`;

        let saved: SavedAttachment;
        try {
          if (!isCurrent()) return;
          saved = saveAttachment(turn.environment, cfg.goblinHome, desiredName, raw);
        } catch (err) {
          log.error("failed to save voice attachment", {
            error: err instanceof Error ? err.message : String(err),
            fileName: desiredName,
            sessionId: turn.session.id,
          });
          if (isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
          }
          return;
        }

        if (!isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = `[Voice message transcript]\n${asrResult.text}\n\n[Voice file \`${escapedPath}\` saved.]`;

        if (!isCurrent()) return;
        await runPrompt(message, turn.surface, runner, turn.session, promptText);
      },
      "runner voice prompt failed",
    );
  }

  async function handleAudio(message: TelegramIntakeMessage, api: Bot["api"], audio: TelegramAudioInput): Promise<void> {
    const turn = await resolveActiveTurn(message, "audio");
    if (!turn) return;

    await turn.schedule(
      async (runner, isCurrent) => {
        const raw = await downloadFileBytes(api, audio.fileId, cfg.botToken);
        if (!isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that audio file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, replyText);
          return;
        }

        let desiredName = audio.fileName?.trim();
        if (!desiredName) {
          const title = [audio.performer, audio.title].filter(Boolean).join(" - ");
          desiredName = title ? `${title}.mp3` : `audio-${Date.now()}.mp3`;
        }

        let saved: SavedAttachment;
        try {
          if (!isCurrent()) return;
          saved = saveAttachment(turn.environment, cfg.goblinHome, desiredName, raw);
        } catch (err) {
          if (err instanceof UnsafeAttachmentNameError) {
            const replyText = "Rejected: unsafe filename.";
            if (isCurrent()) {
              await sendSystemReply(message, replyText, "warn");
              recordAssistantReply(turn.session.id, replyText);
            }
            return;
          }
          log.error("failed to save audio attachment", {
            error: err instanceof Error ? err.message : String(err),
            fileName: desiredName,
            sessionId: turn.session.id,
          });
          if (isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, replyText);
          }
          return;
        }

        if (!isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = audio.caption
          ? `${audio.caption}\n\n[Audio file \`${escapedPath}\` saved.]`
          : `User uploaded audio \`${escapedPath}\`.`;

        if (!isCurrent()) return;
        await runPrompt(message, turn.surface, runner, turn.session, promptText);
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
    } catch (err) {
      log.warn("failed to set topic description", {
        chatId,
        topicId,
        error: err instanceof Error ? err.message : String(err),
      });
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
    const surface = message.surface;
    let conversation: ConversationState;
    try {
      // Guest text is ordinary authorized content; lazily start a conversation.
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (err) {
      log.error("guest resolve failed", { error: String(err), surfaceId: surfaceId(surface) });
      try {
        await message.replyVia(errorArticle());
      } catch (replyErr) {
        log.warn("guest error reply failed", { error: String(replyErr), surfaceId: surfaceId(surface) });
      }
      return;
    }
    const session = runtimeSessionWithPreferences(conversation, surface, cfg.goblinHome);
    const runner = await dispatcher.getOrCreateRunner(session, surface);

    // Busy path: never queue. guest_query_id would expire before a queued turn
    // runs, so reply immediately with a busy fallback to consume the id.
    if (runner.isStreaming) {
      log.debug("guest summon dropped: runner busy", { surfaceId: surfaceId(surface), sessionId: session.id });
      try {
        await message.replyVia(busyArticle());
      } catch (err) {
        log.warn("guest busy reply failed", { error: String(err), surfaceId: surfaceId(surface) });
      }
      return;
    }

    const sink = new GuestReplySink();
    try {
      await runner.prompt(text, sink);
    } catch (err) {
      log.warn("guest turn failed", { error: String(err), surfaceId: surfaceId(surface), sessionId: session.id });
      try {
        await message.replyVia(errorArticle());
      } catch (replyErr) {
        log.warn("guest error reply failed", { error: String(replyErr), surfaceId: surfaceId(surface) });
      }
      return;
    }

    try {
      await message.replyVia(article(sink.text || "(no response)"));
    } catch (err) {
      // Expired guest_query_id or other Telegram failure — swallow so the bot
      // does not crash. The summoner sees nothing; inherent to the one-shot API.
      log.warn("guest reply failed", { error: String(err), surfaceId: surfaceId(surface) });
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
    lifecycle,
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
