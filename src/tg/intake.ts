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
import {
  RuntimeAdmissionFailedBeforeDecisionError,
  type TurnDispatcher,
  type PromptContent,
} from "../orchestration/dispatcher.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { WorkAuthority } from "../orchestration/conversation-runtime-host.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";

import { transcribeWithGroq } from "../asr/mod.ts";
import { GuestReplySink } from "./guest-sink.ts";
import { type ReplyOpts, sendSystemReply } from "./format.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import {
  completed,
  runtimeAdmission,
  type AdmissionResult,
  type RuntimeAdmissionResult,
} from "../shutdown/mod.ts";

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
    run: (runner: AgentRunner, authority: WorkAuthority) => Promise<void>,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ) => Promise<AdmissionResult<void>>;
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

export function replyNoActiveSession(
  message: TelegramIntakeMessage,
  surface: Surface,
  kind: string,
): Promise<void> {
  log.debug(`dropping ${kind}: no conversation`, { surfaceId: surfaceId(surface) });
  if (surface.kind !== "dm") return Promise.resolve();
  return sendSystemReply(
    message,
    "No active conversation. Use /new to start one.",
    "info",
    { propagateErrors: true },
  ).catch(
    (err: unknown) => {
      log.error("failed to send conversation prompt", {
        error: String(err),
        surfaceId: surfaceId(surface),
      });
      throw err;
    },
  );
}

export function createTelegramIntake(options: TelegramIntakeOptions) {
  const { cfg, bot, subagentRunner, memoryStore, dispatcher, lifecycle } = options;

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
  async function applySideEffects(
    sideEffects: SideEffect[],
    message: TelegramIntakeMessage,
  ): Promise<RuntimeAdmissionResult<void> | null> {
    const mapWithContinuation = <T>(
      admission: RuntimeAdmissionResult<T>,
      continuation: (value: T) => Promise<void>,
    ): RuntimeAdmissionResult<void> => {
      const completion = admission.completion.then(continuation);
      switch (admission.kind) {
        case "handoff": return runtimeAdmission.handoff(completion);
        case "busy": return runtimeAdmission.busy(completion);
        case "fenced": return runtimeAdmission.fenced(completion);
        case "rejected": return runtimeAdmission.rejected(completion);
      }
    };

    const applyFrom = async (start: number): Promise<RuntimeAdmissionResult<void> | null> => {
      const completeRemaining = async (next: number): Promise<void> => {
        const remaining = await applyFrom(next);
        if (remaining !== null) await remaining.completion;
      };

      for (let index = start; index < sideEffects.length; index++) {
        const effect = sideEffects[index]!;
        if (effect.kind === "runner-created") {
          const admission = dispatcher.admitGetOrCreateRunner(
            effect.conversation,
            effect.surface,
          );
          return mapWithContinuation(admission, () => completeRemaining(index + 1));
        } else if (effect.kind === "runner-disposed") {
          const admission = dispatcher.admitDisposeRunner(effect.conversationId);
          return mapWithContinuation(admission, () => completeRemaining(index + 1));
        } else if (effect.kind === "queue-prompt") {
          const runnerAdmission = dispatcher.admitGetOrCreateRunner(
            effect.conversation,
            effect.surface,
          );
          const queueRunner = await runnerAdmission.completion;
          const admitted = scheduleFreshTurn(
            message,
            effect.surface,
            effect.conversation,
            queueRunner,
            effect.text,
            "queued prompt failed",
          );
          if (!admitted) {
            log.error("queued prompt rejected at queue admission", {
              sessionId: effect.conversation.id,
            });
            return runtimeAdmission.rejected(undefined);
          }
          return runtimeAdmission.handoff(undefined);
        }
      }
      return null;
    };

    return await applyFrom(0);
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
        // Queue-timing commands cannot attach delegated work.
        if (result.kind === "fallthrough") return;
        if (result.kind === "admission") {
          throw new Error(`queue-timing command ${command} returned delegated admission`);
        }
        const sideEffectAdmission = await applySideEffects(result.sideEffects, message);
        if (sideEffectAdmission !== null) {
          await sideEffectAdmission.completion;
        }
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

  function steerOrFallbackToFreshTurn(
    message: TelegramIntakeMessage,
    surface: Surface,
    session: ConversationState,
    runner: AgentRunner,
    text: string,
  ): RuntimeAdmissionResult<void> {
    const decision = dispatcher.steerOrQueue(
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
    if (decision.kind === "rejected") {
      log.error("late steer race fallback rejected at queue admission", { sessionId: session.id });
      return runtimeAdmission.rejected(undefined);
    }
    if (decision.kind === "queued") return runtimeAdmission.handoff(undefined);
    const completion = decision.followUp.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("steer failed", { error: msg, sessionId: session.id });
      throw err;
    });
    return runtimeAdmission.handoff(completion);
  }

  async function resolveActiveTurn(
    message: TelegramIntakeMessage,
    kind: string,
  ): Promise<ActiveTurn | null> {
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
          try {
            admitted = dispatcher.scheduleBootstrapTurn(
              session,
              surface,
              execute,
              onError,
            );
          } catch (err) {
            throw err;
          }
        } else {
          const runner = await dispatcher.getOrCreateRunner(session, surface);
          if (runner.isAbortTimedOut) {
            const completion = sendSystemReply(message, WEDGED_RUNNER_REPLY, "error").catch((err: unknown) => {
              log.error("failed to send wedged runner reply", {
                error: String(err),
                sessionId: session.id,
              });
              throw err;
            });
            return completed(completion);
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
          return runtimeAdmission.rejected(undefined);
        }
        return runtimeAdmission.handoff(undefined);
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
  ): Promise<AdmissionResult<void>> {
    const surface = message.surface;
    if (!surface) {
      log.debug("dropping message: no surface");
      return completed(undefined);
    }

    const command = parseCommand(rawText);
    const def = command !== null ? resolveCommand(command) : null;
    const existingConversation = lifecycle.inspect(surface);
    if (!existingConversation && command !== null && command !== "/new" && def === null) {
      const delivery = surface.kind === "guest"
        ? Promise.resolve()
        : replyNoActiveSession(message, surface, "text");
      return completed(delivery);
    }

    if (command !== null) {
      const session = existingConversation ?? null;
      const existingRunner = session ? dispatcher.getRunner(session.id) : null;
      const timing = resolveTiming(def, rawText ?? "");
      const runnerIsWedged = existingRunner?.isAbortTimedOut === true;
      if (timing === "queue" && session && runnerIsWedged && !def?.mayRecoverWedgedRuntime) {
        return completed(sendSystemReply(message, WEDGED_RUNNER_REPLY, "error"));
      }
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
        if (!admitted.accepted) {
          log.info("deferred command rejected at queue admission", { command, sessionId: session.id });
          return runtimeAdmission.rejected(undefined);
        }
        const completion = busy
          ? sendSystemReply(message, "Queued. Will run after this turn.", "queued")
          : admitted.completed;
        return runtimeAdmission.handoff(completion);
      }

      try {
        const commandResult = await handleCommand({
          command,
          deps: dispatchDeps,
          rawText: rawText ?? "",
          surface,
          conversation: session,
          existingRunner,
          bot,
        });
        const finishCommand = async (
          result: Exclude<typeof commandResult, { kind: "admission" }>,
        ): Promise<AdmissionResult<void>> => {
          if (result.kind === "fallthrough") return completed(undefined);
          const sideEffectAdmission = await applySideEffects(result.sideEffects, message);
          const queueRejected = sideEffectAdmission?.kind === "rejected" &&
            result.sideEffects.some((effect) => effect.kind === "queue-prompt");
          const delivery = sideEffectAdmission?.completion.then(async () => {
            if (queueRejected) {
              await sendSystemReply(
                message,
                "Queued prompt was dropped: shutdown in progress.",
                "error",
              );
              return;
            }
            if (result.kind === "replied") {
              await sendSystemReply(message, result.reply, result.tag ?? "ok");
            }
          }) ?? (
            result.kind === "replied"
              ? sendSystemReply(message, result.reply, result.tag ?? "ok")
              : Promise.resolve()
          );
          if (sideEffectAdmission !== null) {
            switch (sideEffectAdmission.kind) {
              case "handoff": return runtimeAdmission.handoff(delivery);
              case "busy": return runtimeAdmission.busy(delivery);
              case "fenced": return runtimeAdmission.fenced(delivery);
              case "rejected": return runtimeAdmission.rejected(delivery);
            }
          }
          return completed(delivery);
        };
        if (commandResult.kind === "admission") {
          const completion = commandResult.admission.completion.then(async (result) => {
            const finished = await finishCommand(result);
            if (finished.kind !== "completed") {
              throw new Error("admitted command attempted a second runtime admission");
            }
            await finished.completion;
          });
          switch (commandResult.admission.kind) {
            case "handoff": return runtimeAdmission.handoff(completion);
            case "busy": return runtimeAdmission.busy(completion);
            case "fenced": return runtimeAdmission.fenced(completion);
            case "rejected": return runtimeAdmission.rejected(completion);
            case "completed": return completed(completion);
          }
        }
        if (commandResult.kind !== "fallthrough") {
          return await finishCommand(commandResult);
        }
      } catch (err) {
        if (err instanceof RuntimeAdmissionFailedBeforeDecisionError) throw err;
        log.error("command dispatch failed", { error: String(err), command, sessionId: session?.id });
        const replyText = "Something went wrong. Please try again.";
        const delivery = sendSystemReply(message, replyText, "error").then(() => {
          if (session) recordAssistantReply(session.id, surface, existingRunner, replyText);
        });
        return completed(delivery);
      }
    }

    const conversation = await lifecycle.resolveOrStart(surface);
    const session = conversation;
    if (!rawText) return completed(undefined);

    const existingRunner = dispatcher.getRunner(session.id);
    if (existingRunner === null) {
      const admitted = dispatcher.scheduleBootstrapTurn(
        session,
        surface,
        async (runner, authority) => {
          if (runner.isAbortTimedOut) {
            if (authority.isCurrent()) await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
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
        return runtimeAdmission.rejected(undefined);
      }
      return runtimeAdmission.handoff(undefined);
    }

    const runner = await dispatcher.getOrCreateRunner(session, surface);
    if (runner.isAbortTimedOut) {
      return completed(sendSystemReply(message, WEDGED_RUNNER_REPLY, "error"));
    }
    if (runner.isStreaming) {
      return steerOrFallbackToFreshTurn(message, surface, session, runner, rawText);
    }

    const admitted = scheduleFreshTurn(message, surface, session, runner, rawText, "runner prompt failed");
    if (!admitted) {
      log.error("runner prompt rejected at queue admission", { sessionId: session.id });
      return runtimeAdmission.rejected(undefined);
    }
    return runtimeAdmission.handoff(undefined);
  }

  async function handlePhoto(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    fileIds: string[],
    caption?: string,
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(message, "photo");
    if (!turn) return completed(undefined);

    return turn.schedule(
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
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(message, "document");
    if (!turn) return completed(undefined);

    return turn.schedule(
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
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(message, "voice");
    if (!turn) return completed(undefined);

    return turn.schedule(
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
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(message, "audio");
    if (!turn) return completed(undefined);

    return turn.schedule(
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
  ): Promise<AdmissionResult<void>> {
    if (chatId === undefined || topicId === undefined || name === undefined) {
      return completed(undefined);
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
    }
    return completed(undefined);
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
  ): Promise<AdmissionResult<void>> {
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
      return completed(replyOnce(errorArticle(), "guest error reply failed"));
    }

    const sink = new GuestReplySink();
    const admission = dispatcher.admitImmediateTurn(
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

    switch (admission.kind) {
      case "accepted": {
        const completion = admission.settlement.then(async (settlement) => {
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
        });
        return runtimeAdmission.handoff(completion);
      }
      case "busy":
        log.debug("guest summon dropped: runtime busy", {
          surfaceId: surfaceId(surface),
          sessionId: conversation.id,
        });
        return runtimeAdmission.busy(replyOnce(busyArticle(), "guest busy reply failed"));
      case "closed":
        return runtimeAdmission.rejected(undefined);
      case "fenced":
        return runtimeAdmission.fenced(undefined);
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
