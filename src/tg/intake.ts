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
import type { WorkAuthority } from "../orchestration/conversation-runtime-host.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";

import { transcribeWithGroq } from "../asr/mod.ts";
import { GuestReplySink } from "./guest-sink.ts";
import { type ReplyOpts, sendSystemReply } from "./format.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { UpdateHandle, UpdateGate } from "../shutdown/mod.ts";

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
  /** Process-level update gate that owns admission tracking and the
   * coalescer close coupling. Replaces intake's local admission flag. */
  gate: UpdateGate;
}

type ActiveTurn = {
  surface: Surface;
  session: ConversationState;
  environment: ExecutionEnvironment;
  schedule: (
    run: (runner: AgentRunner, authority: WorkAuthority) => Promise<void>,
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
  const { cfg, bot, subagentRunner, memoryStore, dispatcher, lifecycle, gate } = options;

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
      { kind: "current-runtime", runner },
      async (authority) => {
        if (!authority.isCurrent()) return;
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
        const admitted = scheduleFreshTurn(message, effect.surface, effect.conversation, queueRunner, effect.text, "queued prompt failed");
        if (!admitted) {
          log.error("queued prompt rejected at queue admission", { sessionId: effect.conversation.id });
          await sendSystemReply(message, "Queued prompt was dropped: shutdown in progress.", "error").catch((err: unknown) => {
            log.error("failed to send queued prompt drop reply", { error: String(err), sessionId: effect.conversation.id });
          });
        }
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
   * The machine-held binding authority gate is binding-based: a `/new` or `/resume`
   * makes later commands stale, while a same-binding runtime invalidation such
   * as `/model` preserves their acknowledged arrival order.
   */
  interface DeferredCommandAdmission {
    readonly accepted: boolean;
    readonly completed: Promise<void>;
  }

  function scheduleDeferredCommand(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: ConversationState,
    rawText: string,
    command: string,
  ): DeferredCommandAdmission {
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const accepted = dispatcher.scheduleCommand(
      session,
      surface,
      async (authority) => {
        if (!authority.isCurrent()) return;
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
      resolveCompleted,
    );
    return { accepted, completed };
  }

  async function steerOrFallbackToFreshTurn(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: ConversationState,
    runner: AgentRunner,
    text: string,
    handle?: UpdateHandle,
  ): Promise<void> {
    // One synchronous machine section either attaches the follow-up or
    // admits the late-steer fallback. Telegram admission is released only
    // after that decision, so shutdown cannot observe a released handle
    // with neither a follow-up nor a queued fallback.
    let decision: ReturnType<TurnDispatcher["steerOrQueue"]>;
    try {
      decision = dispatcher.steerOrQueue(
        session,
        { kind: "current-runtime", runner },
        () => runner.followUp(message.prepare(text)),
        async (authority) => {
          if (!authority.isCurrent()) return;
          const buffer = dispatcher.createMessageBuffer(surface, session);
          await runner.prompt(message.prepare(text), buffer);
        },
        async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("runner prompt failed (late steer race fallback)", { error: msg, sessionId: session.id });
        },
      );
    } finally {
      handle?.releaseRuntimeAdmission();
    }
    if (decision.kind === "rejected") {
      log.error("late steer race fallback rejected at queue admission", { sessionId: session.id });
      return;
    }
    if (decision.kind === "queued") return;
    try {
      await decision.followUp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("steer failed", { error: msg, sessionId: session.id });
      throw err;
    }
  }

  async function resolveActiveTurn(
    message: TelegramIntakeMessage,
    kind: string,
    handle?: UpdateHandle,
  ): Promise<ActiveTurn | null> {
    const surface = message.surface;
    if (!surface) {
      log.debug(`dropping ${kind}: no surface`);
      handle?.releaseRuntimeAdmission();
      return null;
    }

    // Photos, documents, voice, and audio are ordinary authorized content:
    // lazily create a conversation on the surface, just like text.
    let conversation: ConversationState;
    try {
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (err) {
      log.error(`failed to resolve ${kind}`, { error: String(err), surfaceId: surfaceId(surface) });
      handle?.releaseRuntimeAdmission();
      return null;
    }
    const session = conversation;

    return {
      surface,
      session,
      environment: conversation.executionEnvironment,
      schedule: async (run, failureLog, opts) => {
        let admittedRunner: AgentRunner | undefined;
        const execute = async (runner: AgentRunner, authority: WorkAuthority): Promise<void> => {
          admittedRunner = runner;
          if (runner.isAbortTimedOut) {
            if (!authority.isCurrent()) return;
            await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
            return;
          }
          await run(runner, authority);
        };
        const onError = async (err: unknown): Promise<void> => {
          if (opts?.replyModelNotCapable && err instanceof ModelNotCapableError) {
            await sendSystemReply(message, err.message, "error");
            if (admittedRunner !== undefined) {
              recordAssistantReply(session.id, surface, admittedRunner, err.message);
            }
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          log.error(failureLog, { error: msg, sessionId: session.id });
        };

        const existingRunner = dispatcher.getRunner(session.id);
        let admitted: boolean;
        if (existingRunner === null) {
          admitted = dispatcher.scheduleBootstrapTurn(
            session,
            surface,
            execute,
            onError,
          );
        } else {
          let runner: AgentRunner;
          try {
            runner = await dispatcher.getOrCreateRunner(session, surface);
          } catch (err) {
            handle?.releaseRuntimeAdmission();
            throw err;
          }
          if (runner.isAbortTimedOut) {
            handle?.releaseRuntimeAdmission();
            sendSystemReply(message, WEDGED_RUNNER_REPLY, "error").catch((err: unknown) => {
              log.error("failed to send wedged runner reply", {
                error: String(err),
                sessionId: session.id,
              });
            });
            return;
          }
          admitted = dispatcher.schedulePrompt(
            session,
            { kind: "current-runtime", runner },
            (authority) => execute(runner, authority),
            onError,
          );
        }
        if (!admitted) {
          log.error("media prompt rejected at queue admission", { sessionId: session.id });
          handle?.releaseRuntimeAdmission();
          return;
        }
        // The machine owns cold preparation and work before the update barrier
        // is released; shutdown can now fence/cancel either phase.
        handle?.releaseRuntimeAdmission();
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
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("text")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const surface = message.surface;
    if (!surface) {
      log.debug("dropping message: no surface");
      handle?.releaseRuntimeAdmission();
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
      handle?.releaseRuntimeAdmission();
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
        handle?.releaseRuntimeAdmission();
        await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
        return;
      }
      // Interrupt-timing (/cancel) and instant-timing commands run immediately.
      const busy = !runnerIsWedged && (
        existingRunner?.isStreaming ||
        existingRunner?.isPrompting ||
        (session ? dispatcher.hasPromptWork(session.id) : false) ||
        (session ? dispatcher.isCommandPending(session.id) : false)
      );
      const recoverWedgedRuntime = timing === "queue" && session !== null &&
        runnerIsWedged && def?.mayRecoverWedgedRuntime === true;
      if (timing === "queue" && session && !recoverWedgedRuntime) {
        const admitted = scheduleDeferredCommand(message, surface, session, rawText ?? "", command);
        if (admitted.accepted) {
          handle?.releaseRuntimeAdmission();
          if (busy) {
            await sendSystemReply(message, "Queued. Will run after this turn.", "queued");
          } else {
            // Even an idle queue owns the command's serialization boundary.
            // Await its completion so direct commands retain their normal
            // reply timing; Telegram admission was released above so model
            // work can still be unblocked by shutdown.
            await admitted.completed;
          }
        } else {
          log.info("deferred command rejected at queue admission", {
            command,
            sessionId: session.id,
          });
          handle?.releaseRuntimeAdmission();
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
          handle,
          bot,
        });
        // Interrupt commands deliberately operate on an active runtime. Let
        // shutdown begin after the interrupt has been invoked; waiting for
        // its abort promise would prevent runtime disposal from unblocking it.
        // `/compact` is queue-timing but releases early here for the no-session
        // path: there is no active runtime to unblock, but releasing early is
        // harmless and keeps the handle settled before the command result.
        if (timing === "interrupt" || command === "/compact") handle?.releaseRuntimeAdmission();
        const result = await commandResult;
        if (result.kind !== "fallthrough") {
          await applySideEffects(result.sideEffects, message);
          handle?.releaseRuntimeAdmission();
          if (result.kind === "handled") return;
          await sendSystemReply(message, result.reply, result.tag ?? "ok");
          return;
        }
      } catch (err) {
        log.error("command dispatch failed", { error: String(err), command, sessionId: session?.id });
        handle?.releaseRuntimeAdmission();
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
      handle?.releaseRuntimeAdmission();
      throw error;
    }
    const session = conversation;

    if (!rawText) {
      handle?.releaseRuntimeAdmission();
      return;
    }

    const existingRunner = dispatcher.getRunner(session.id);
    if (existingRunner === null) {
      const admitted = dispatcher.scheduleBootstrapTurn(
        session,
        surface,
        async (runner, authority) => {
          if (runner.isAbortTimedOut) {
            if (!authority.isCurrent()) return;
            await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
            return;
          }
          if (!authority.isCurrent()) return;
          const buffer = dispatcher.createMessageBuffer(surface, session);
          await runner.prompt(message.prepare(rawText), buffer);
        },
        async (error) => {
          log.error("runner prompt failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: session.id,
          });
        },
      );
      if (!admitted) {
        log.error("runner prompt rejected at queue admission", { sessionId: session.id });
        handle?.releaseRuntimeAdmission();
        return;
      }
      handle?.releaseRuntimeAdmission();
      return;
    }

    let runner: AgentRunner;
    try {
      runner = await dispatcher.getOrCreateRunner(session, surface);
    } catch (error) {
      handle?.releaseRuntimeAdmission();
      throw error;
    }

    if (runner.isAbortTimedOut) {
      handle?.releaseRuntimeAdmission();
      await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
      return;
    }

    if (runner.isStreaming) {
      await steerOrFallbackToFreshTurn(message, surface, session, runner, rawText, handle);
      return;
    }

    const admitted = scheduleFreshTurn(message, surface, session, runner, rawText, "runner prompt failed");
    if (!admitted) {
      log.error("runner prompt rejected at queue admission", { sessionId: session.id });
      handle?.releaseRuntimeAdmission();
      return;
    }
    // The prompt is now queued; model work is released by runtime disposal.
    handle?.releaseRuntimeAdmission();
  }

  async function handlePhoto(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    fileIds: string[],
    caption?: string,
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("photo")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const turn = await resolveActiveTurn(message, "photo", handle);
    if (!turn) return;

    await turn.schedule(
      async (runner, authority) => {
        const photo = await downloadPhoto(api, fileIds, cfg.botToken);
        if (!authority.isCurrent()) return;
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

        if (!authority.isCurrent()) return;
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
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("document")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const turn = await resolveActiveTurn(message, "document", handle);
    if (!turn) return;

    await turn.schedule(
      async (runner, authority) => {
        const raw = await downloadFileBytes(api, doc.fileId, cfg.botToken);
        if (!authority.isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          return;
        }

        const desiredName = doc.fileName || "attachment";
        let saved: SavedAttachment;
        try {
          if (!authority.isCurrent()) return;
          saved = saveAttachment(turn.environment, cfg.goblinHome, desiredName, raw);
        } catch (err) {
          if (err instanceof UnsafeAttachmentNameError) {
            const replyText = "Rejected: unsafe filename.";
            if (authority.isCurrent()) {
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
          if (authority.isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        if (!authority.isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = doc.caption
          ? `${doc.caption}\n\n[File \`${escapedPath}\` saved.]`
          : `User uploaded \`${escapedPath}\`.`;

        if (!authority.isCurrent()) return;
        await runPrompt(message, turn.surface, runner, turn.session, promptText);
      },
      "runner document prompt failed",
    );
  }

  async function handleVoice(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    voice: TelegramVoiceInput,
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("voice")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const turn = await resolveActiveTurn(message, "voice", handle);
    if (!turn) return;

    await turn.schedule(
      async (runner, authority) => {
        // Groq ASR setup gate: missing key fails at use time with a clear
        // message rather than at startup. Checked inside the scheduled task so
        // the reply respects the stale-runner guard and stays non-blocking.
        if (!cfg.groqApiKey) {
          if (!authority.isCurrent()) return;
          const replyText = "Groq ASR is not configured. Add a Groq API key to transcribe voice messages.";
          await sendSystemReply(message, replyText, "warn");
          recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          return;
        }

        // One download serves both ASR and optional project-file saving, so a
        // failure here short-circuits before either side effect.
        const raw = await downloadFileBytes(api, voice.fileId, cfg.botToken);
        if (!authority.isCurrent()) return;
        if (!raw) {
          if (authority.isCurrent()) {
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
        if (!authority.isCurrent()) return;

        if (!asrResult.ok) {
          // Transport/API failure only; the sanitized error carries no secrets.
          log.warn("voice transcription failed", { error: asrResult.error, sessionId: turn.session.id });
          if (authority.isCurrent()) {
            const replyText = "Sorry, I couldn't transcribe that voice message.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        // Intake owns the semantic empty-text check: a successful HTTP response
        // with no speech is not an ASR failure.
        if (asrResult.text.length === 0) {
          if (authority.isCurrent()) {
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
          if (!authority.isCurrent()) return;
          saved = saveAttachment(turn.environment, cfg.goblinHome, desiredName, raw);
        } catch (err) {
          log.error("failed to save voice attachment", {
            error: err instanceof Error ? err.message : String(err),
            fileName: desiredName,
            sessionId: turn.session.id,
          });
          if (authority.isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        if (!authority.isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = `[Voice message transcript]\n${asrResult.text}\n\n[Voice file \`${escapedPath}\` saved.]`;

        if (!authority.isCurrent()) return;
        await runPrompt(message, turn.surface, runner, turn.session, promptText);
      },
      "runner voice prompt failed",
    );
  }

  async function handleAudio(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    audio: TelegramAudioInput,
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("audio")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const turn = await resolveActiveTurn(message, "audio", handle);
    if (!turn) return;

    await turn.schedule(
      async (runner, authority) => {
        const raw = await downloadFileBytes(api, audio.fileId, cfg.botToken);
        if (!authority.isCurrent()) return;
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
          if (!authority.isCurrent()) return;
          saved = saveAttachment(turn.environment, cfg.goblinHome, desiredName, raw);
        } catch (err) {
          if (err instanceof UnsafeAttachmentNameError) {
            const replyText = "Rejected: unsafe filename.";
            if (authority.isCurrent()) {
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
          if (authority.isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        if (!authority.isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = audio.caption
          ? `${audio.caption}\n\n[Audio file \`${escapedPath}\` saved.]`
          : `User uploaded audio \`${escapedPath}\`.`;

        if (!authority.isCurrent()) return;
        await runPrompt(message, turn.surface, runner, turn.session, promptText);
      },
      "runner audio prompt failed",
    );
  }

  async function handleTopicDescription(
    chatId: number | undefined,
    topicId: number | undefined,
    name: string | undefined,
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("topic-description")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    if (chatId === undefined || topicId === undefined || name === undefined) {
      handle?.releaseRuntimeAdmission();
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
      handle?.releaseRuntimeAdmission();
    }
  }

  /**
   * Resolve guest Surface binding and hand one immediate/no-wait turn to the
   * runtime kernel. Telegram retains only the opaque one-shot reply mapping;
   * runner occupancy, authority, prompting, and settlement stay behind the
   * dispatcher/machine boundary.
   */
  async function handleGuestMessage(
    message: GuestMessage,
    text: string,
    handle?: UpdateHandle,
  ): Promise<void> {
    if (!gate.admit("guest")) {
      handle?.releaseRuntimeAdmission();
      return;
    }
    const surface = message.surface;
    let replyAttempted = false;
    const replyOnce = async (result: InlineQueryResult, failureLog: string): Promise<void> => {
      if (replyAttempted) return;
      replyAttempted = true;
      try {
        await message.replyVia(result);
      } catch (error) {
        log.warn(failureLog, { error: String(error), surfaceId: surfaceId(surface) });
      }
    };

    let conversation: ConversationState;
    try {
      conversation = await lifecycle.resolveOrStart(surface);
    } catch (error) {
      log.error("guest resolve failed", { error: String(error), surfaceId: surfaceId(surface) });
      handle?.releaseRuntimeAdmission();
      await replyOnce(errorArticle(), "guest error reply failed");
      return;
    }

    const sink = new GuestReplySink();
    let admission: ReturnType<TurnDispatcher["admitImmediateTurn"]>;
    try {
      admission = dispatcher.admitImmediateTurn(
        conversation,
        surface,
        text,
        sink,
        {
          success: () => replyOnce(article(sink.text || "(no response)"), "guest reply failed"),
          failure: async (error) => {
            log.warn("guest turn failed", {
              error: error instanceof Error ? error.message : String(error),
              surfaceId: surfaceId(surface),
              sessionId: conversation.id,
            });
            await replyOnce(errorArticle(), "guest error reply failed");
          },
        },
      );
    } catch (error) {
      log.error("guest runtime admission failed", {
        error: error instanceof Error ? error.message : String(error),
        surfaceId: surfaceId(surface),
        sessionId: conversation.id,
      });
      handle?.releaseRuntimeAdmission();
      await replyOnce(errorArticle(), "guest error reply failed");
      return;
    }

    handle?.releaseRuntimeAdmission();
    switch (admission.kind) {
      case "accepted": {
        const settlement = await admission.settlement;
        if (settlement.kind === "failed") {
          log.error("accepted guest runtime work failed", {
            error: settlement.error instanceof Error
              ? settlement.error.message
              : String(settlement.error),
            surfaceId: surfaceId(surface),
            sessionId: conversation.id,
          });
        }
        if (settlement.delivery !== undefined) await settlement.delivery;
        return;
      }
      case "busy":
        log.debug("guest summon dropped: runtime busy", {
          surfaceId: surfaceId(surface),
          sessionId: conversation.id,
        });
        await replyOnce(busyArticle(), "guest busy reply failed");
        return;
      case "closed":
      case "fenced":
        return;
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
