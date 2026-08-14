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
import { MemoryStore } from "../memory/mod.ts";
import { type ConversationState } from "../sessions/mod.ts";
import { surfaceId, type Surface, type GuestSurface } from "../surface.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { saveAttachment, UnsafeAttachmentNameError, type SavedAttachment } from "./attachments.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { TurnDispatcher, PromptContent } from "../orchestration/dispatcher.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";

import { transcribeWithGroq } from "../asr/mod.ts";
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
  /** Runtime kernel assembled by the composition root. */
  dispatcher: TurnDispatcher;
  lifecycle: ConversationLifecycle;
  /** Shared schedule store for `/schedule`. */
  scheduleStore?: ScheduleStore;
  /** Shared external agent runner. Wired in Phase 6 (bot.ts). */
  externalAgentRunner?: ExternalAgentRunner;
}

type ActiveTurn = {
  surface: Surface;
  session: ConversationState;
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
  const { cfg, bot, subagentRunner, memoryStore, dispatcher, lifecycle } = options;
  let admissionOpen = true;

  function closeAdmission(): void {
    if (!admissionOpen) return;
    admissionOpen = false;
    log.info("telegram intake admission closed");
  }

  function admit(kind: string): boolean {
    if (admissionOpen) return true;
    log.info("telegram intake dropped after admission closed", { kind });
    return false;
  }

  function recordAssistantReply(
    sessionId: string,
    surface: Surface,
    runner: AgentRunner | null | undefined,
    text: string,
  ): void {
    const ctx = runner && runner.memoryContext.kind === "surface"
      ? { kind: "surface" as const, sourceSurfaceId: runner.memoryContext.authority.sourceSurfaceId }
      : undefined;
    if (!ctx) {
      log.warn("no-transcript-writer-context", {
        sessionId,
        surfaceId: surfaceId(surface),
        surfaceKind: surface.kind,
        runnerPresent: !!runner,
        runnerKind: runner?.memoryContext.kind ?? null,
      });
      return;
    }
    appendAssistantTranscriptEntry(sessionId, cfg.goblinHome, text, ctx);
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
    session: ConversationState,
    runner: AgentRunner,
    content: PromptContent,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ): boolean {
    const buffer = dispatcher.createMessageBuffer(surface, session);
    return dispatcher.schedulePrompt(
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
  async function applySideEffects(sideEffects: SideEffect[], message: TelegramIntakeMessage): Promise<void> {
    for (const effect of sideEffects) {
      if (effect.kind === "runner-created") {
        await dispatcher.getOrCreateRunner(effect.conversation, effect.surface);
      } else if (effect.kind === "runner-disposed") {
        await dispatcher.disposeRunner(effect.conversationId);
      } else if (effect.kind === "queue-prompt") {
        const queueRunner = await dispatcher.getOrCreateRunner(effect.conversation, effect.surface);
        scheduleFreshTurn(message, effect.surface, effect.conversation, queueRunner, effect.text, "queued prompt failed");
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
   * The `isCurrent()` staleness gate is binding-based: a `/new` or `/resume`
   * makes later commands stale, while a same-binding runtime invalidation such
   * as `/model` preserves their acknowledged arrival order.
   */
  function scheduleDeferredCommand(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: ConversationState,
    rawText: string,
    command: string,
  ): boolean {
    return dispatcher.scheduleCommand(
      session,
      surface,
      async (isCurrent) => {
        if (!isCurrent()) return;
        const result = await handleCommand({
          command,
          deps: dispatchDeps,
          rawText,
          surface,

          conversation: session,
          existingRunner: dispatcher.getRunner(session.id),
          bot,
        });
        // Queue-timing commands always have a handler, so fallthrough is
        // impossible here — but narrow for the typechecker regardless.
        if (result.kind === "fallthrough") return;
        await applySideEffects(result.sideEffects, message);
        if (result.kind === "replied") await sendSystemReply(message, result.reply, result.tag ?? "ok");
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("deferred command failed", { error: msg, command, sessionId: session.id });
        const replyText = `/${command} failed after the turn: ${msg}`;
        await sendSystemReply(message, replyText, "error").catch(() => {});
        const currentRunner = dispatcher.getRunner(session.id);
        recordAssistantReply(session.id, surface, currentRunner, replyText);
      },
    );
  }

  async function steerOrFallbackToFreshTurn(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: ConversationState,
    runner: AgentRunner,
    text: string,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    const followUp = runner.followUp(message.prepare(text));

    // AgentRunner.followUp() validates streaming asynchronously. Give an
    // immediate rejection (the steer-vs-fresh-turn race) one event-loop turn
    // to surface before declaring the Telegram update admitted. Once a steer
    // has got past that validation, its promise may remain pending until
    // runtime disposal, so do not wait for it before releasing the barrier.
    const outcome = await new Promise<
      { kind: "pending" } | { kind: "fulfilled" } | { kind: "rejected"; error: unknown }
    >((resolve) => {
      let settled = false;
      const settle = (
        result: { kind: "fulfilled" } | { kind: "rejected"; error: unknown } | { kind: "pending" },
      ): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      void followUp.then(
        () => settle({ kind: "fulfilled" }),
        (error: unknown) => settle({ kind: "rejected", error }),
      );
      // A pending follow-up is an accepted steer. The timer is only the
      // bounded observation window for validation failures that reject
      // immediately; it does not wait for model work.
      setTimeout(() => settle({ kind: "pending" }), 0);
    });

    if (outcome.kind === "rejected") {
      const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      if (msg.includes("not streaming")) {
        const admitted = scheduleFreshTurn(
          message,
          surface,
          session,
          runner,
          text,
          "runner prompt failed (steer race fallback)",
        );
        if (!admitted) {
          log.error("steer race fallback rejected at queue admission", { sessionId: session.id });
        }
        // The fallback has now either entered the runtime queue or been
        // proven impossible. In both cases no pending steer remains to hold
        // the Telegram barrier.
        onRuntimeAdmission?.();
        return;
      }
      // This failure is not recoverable by starting a fresh turn, but it has
      // still reached the same runtime hand-off boundary as a steer.
      onRuntimeAdmission?.();
      throw outcome.error;
    }

    // Admission is the synchronous hand-off to the runtime. Do not wait for
    // the model-owned promise: disposal is what unblocks a stalled follow-up.
    onRuntimeAdmission?.();
    try {
      await followUp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not streaming")) {
        // The normal race is handled above. Preserve the fallback for a
        // backend that reports the same condition after the bounded
        // observation window, but surface a shutdown-time rejection.
        const admitted = scheduleFreshTurn(
          message,
          surface,
          session,
          runner,
          text,
          "runner prompt failed (late steer race fallback)",
        );
        if (!admitted) {
          log.error("late steer race fallback rejected at queue admission", { sessionId: session.id });
        }
        return;
      }
      log.warn("steer failed", { error: msg, sessionId: session.id });
      throw err;
    }
  }

  async function resolveActiveTurn(
    message: TelegramIntakeMessage,
    kind: string,
    onRuntimeAdmission?: () => void,
  ): Promise<ActiveTurn | null> {
    const surface = message.surface;
    if (!surface) {
      log.debug(`dropping ${kind}: no surface`);
      onRuntimeAdmission?.();
      return null;
    }

    // Photos, documents, voice, and audio are ordinary authorized content:
    // lazily create a conversation on the surface, just like text.
    let conversation: ConversationState;
    try {
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (err) {
      log.error(`failed to resolve ${kind}`, { error: String(err), surfaceId: surfaceId(surface) });
      onRuntimeAdmission?.();
      return null;
    }
    const session = conversation;

    return {
      surface,
      session,
      environment: conversation.executionEnvironment,
      schedule: async (run, failureLog, opts) => {
        let runner: AgentRunner;
        try {
          runner = await dispatcher.getOrCreateRunner(session, surface);
        } catch (err) {
          onRuntimeAdmission?.();
          throw err;
        }
        if (runner.isAbortTimedOut) {
          onRuntimeAdmission?.();
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
              recordAssistantReply(session.id, surface, runner, err.message);
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            log.error(failureLog, { error: msg, sessionId: session.id });
          },
        );
        // The queue now owns the update. Downloading media and running the
        // model may continue until runtime disposal releases it.
        onRuntimeAdmission?.();
      },
    };
  }

  const dispatchDeps: DispatchDeps = {
    lifecycle,
    subagentRunner,
    cfg,
    tryResolveModel,
    interruptAndCascade,
    scheduleStore: options.scheduleStore,
    dispatcher,
    externalAgentRunner: options.externalAgentRunner,
  };

  async function runPrompt(message: TelegramIntakeMessage, surface: Surface, runner: AgentRunner, session: ConversationState, content: PromptContent): Promise<void> {
    const buffer = dispatcher.createMessageBuffer(surface, session);
    await runner.prompt(message.prepare(content), buffer);
  }

  async function handleText(
    message: TelegramIntakeMessage,
    rawText: string | undefined,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("text")) {
      onRuntimeAdmission?.();
      return;
    }
    const surface = message.surface;
    if (!surface) {
      log.debug("dropping message: no surface");
      onRuntimeAdmission?.();
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
      onRuntimeAdmission?.();
      return;
    }

    if (command !== null) {
      // Commands, status reads, and scheduler-related interactions inspect the
      // current binding without creating history.
      const session = existingConversation ? existingConversation : null;
      const existingRunner = session ? dispatcher.getRunner(session.id) : null;
      const timing = resolveTiming(def, rawText ?? "");

      // Queue-timing commands defer behind an in-flight turn so the runner is
      // idle when they mutate state (model switch, project rebind, archive,
      // compact, etc.). They also defer behind a prompt that has already started
      // (isPrompting), e.g. a coalescer-flushed prompt whose handleText has
      // already called runner.prompt, and behind any already-deferred command.
      //
      // An abort-timed-out runtime is different: its prompt cannot be used as
      // a queue owner because it may never settle. Only registry-declared
      // lifecycle recovery commands may bypass it; they synchronously
      // invalidate the runtime before changing durable authority. Other
      // queue-timing commands return the recovery guidance instead of lying
      // that they will eventually run.
      const runnerIsWedged = existingRunner?.isAbortTimedOut === true;
      if (timing === "queue" && session && runnerIsWedged && !def?.mayRecoverWedgedRuntime) {
        onRuntimeAdmission?.();
        await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
        return;
      }
      // Interrupt-timing (/cancel) and instant-timing commands run immediately.
      const busy = !runnerIsWedged && (
        existingRunner?.isStreaming ||
        existingRunner?.isPrompting ||
        (session ? dispatcher.isCommandPending(session.id) : false)
      );
      if (timing === "queue" && session && busy) {
        const admitted = scheduleDeferredCommand(message, surface, session, rawText ?? "", command);
        if (admitted) {
          onRuntimeAdmission?.();
          await sendSystemReply(message, "Queued. Will run after this turn.", "queued");
        } else {
          log.info("deferred command rejected at queue admission", {
            command,
            sessionId: session.id,
          });
          onRuntimeAdmission?.();
        }
        return;
      }

      try {
        const commandResult = handleCommand({
          command,
          deps: dispatchDeps,
          rawText: rawText ?? "",
          surface,

          conversation: session,
          existingRunner,
          bot,
        });
        // Interrupt commands deliberately operate on an active runtime. Let
        // shutdown begin after the interrupt has been invoked; waiting for
        // its abort promise would prevent runtime disposal from unblocking it.
        if (timing === "interrupt" || command === "compact") onRuntimeAdmission?.();
        const result = await commandResult;
        if (result.kind !== "fallthrough") {
          await applySideEffects(result.sideEffects, message);
          onRuntimeAdmission?.();
          if (result.kind === "handled") return;
          await sendSystemReply(message, result.reply, result.tag ?? "ok");
          return;
        }
      } catch (err) {
        log.error("command dispatch failed", { error: String(err), command, sessionId: session?.id });
        onRuntimeAdmission?.();
        await sendSystemReply(message, "Something went wrong. Please try again.", "error");
        if (session) recordAssistantReply(session.id, surface, existingRunner, "Something went wrong. Please try again.");
        return;
      }
    }

    // Ordinary authorized content lazily creates a conversation on any supported
    // surface, including DMs and guest text.
    let conversation: ConversationState;
    try {
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (error) {
      // No runtime admission is possible after lifecycle resolution fails, but
      // the shutdown barrier must still be released rather than hanging
      // forever on a failed dispatch.
      onRuntimeAdmission?.();
      throw error;
    }
    const session = conversation;

    let runner: AgentRunner;
    try {
      runner = await dispatcher.getOrCreateRunner(session, surface);
    } catch (error) {
      onRuntimeAdmission?.();
      throw error;
    }
    if (!rawText) {
      onRuntimeAdmission?.();
      return;
    }

    if (runner.isAbortTimedOut) {
      onRuntimeAdmission?.();
      await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
      return;
    }

    if (runner.isStreaming) {
      await steerOrFallbackToFreshTurn(message, surface, session, runner, rawText, onRuntimeAdmission);
      return;
    }

    scheduleFreshTurn(message, surface, session, runner, rawText, "runner prompt failed");
    // The prompt is now queued; model work is released by runtime disposal.
    onRuntimeAdmission?.();
  }

  async function handlePhoto(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    fileIds: string[],
    caption?: string,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("photo")) {
      onRuntimeAdmission?.();
      return;
    }
    const turn = await resolveActiveTurn(message, "photo", onRuntimeAdmission);
    if (!turn) return;

    await turn.schedule(
      async (runner, isCurrent) => {
        const photo = await downloadPhoto(api, fileIds, cfg.botToken);
        if (!isCurrent()) return;
        if (!photo) {
          const replyText = "Sorry, I couldn't download that image.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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

  async function handleDocument(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    doc: TelegramDocumentInput,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("document")) {
      onRuntimeAdmission?.();
      return;
    }
    const turn = await resolveActiveTurn(message, "document", onRuntimeAdmission);
    if (!turn) return;

    await turn.schedule(
      async (runner, isCurrent) => {
        const raw = await downloadFileBytes(api, doc.fileId, cfg.botToken);
        if (!isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
              recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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

  async function handleVoice(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    voice: TelegramVoiceInput,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("voice")) {
      onRuntimeAdmission?.();
      return;
    }
    const turn = await resolveActiveTurn(message, "voice", onRuntimeAdmission);
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
          recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        // Intake owns the semantic empty-text check: a successful HTTP response
        // with no speech is not an ASR failure.
        if (asrResult.text.length === 0) {
          if (isCurrent()) {
            const replyText = "No speech was detected in that voice message.";
            await sendSystemReply(message, replyText, "info");
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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

  async function handleAudio(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    audio: TelegramAudioInput,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("audio")) {
      onRuntimeAdmission?.();
      return;
    }
    const turn = await resolveActiveTurn(message, "audio", onRuntimeAdmission);
    if (!turn) return;

    await turn.schedule(
      async (runner, isCurrent) => {
        const raw = await downloadFileBytes(api, audio.fileId, cfg.botToken);
        if (!isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that audio file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
              recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
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

  async function handleTopicDescription(
    chatId: number | undefined,
    topicId: number | undefined,
    name: string | undefined,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("topic-description")) {
      onRuntimeAdmission?.();
      return;
    }
    if (chatId === undefined || topicId === undefined || name === undefined) {
      onRuntimeAdmission?.();
      return;
    }
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
    } finally {
      onRuntimeAdmission?.();
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
  async function handleGuestMessage(
    message: GuestMessage,
    text: string,
    onRuntimeAdmission?: () => void,
  ): Promise<void> {
    if (!admit("guest")) {
      onRuntimeAdmission?.();
      return;
    }
    const surface = message.surface;
    let conversation: ConversationState;
    try {
      // Guest text is ordinary authorized content; lazily start a conversation.
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (err) {
      log.error("guest resolve failed", { error: String(err), surfaceId: surfaceId(surface) });
      onRuntimeAdmission?.();
      try {
        await message.replyVia(errorArticle());
      } catch (replyErr) {
        log.warn("guest error reply failed", { error: String(replyErr), surfaceId: surfaceId(surface) });
      }
      return;
    }
    const session = conversation;
    let runner: AgentRunner;
    try {
      runner = await dispatcher.getOrCreateRunner(session, surface);
    } finally {
      onRuntimeAdmission?.();
    }

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
    // Guest turns run directly rather than through the Telegram streaming
    // queue. The prompt call is the runtime admission boundary.
    onRuntimeAdmission?.();
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
    closeAdmission,
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
