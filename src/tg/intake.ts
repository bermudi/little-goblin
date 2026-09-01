import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import type { InlineQueryResult } from "@grammyjs/types";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { boundedError, log } from "../log.ts";
import { AgentRunner, appendAssistantTranscriptEntry, ModelNotCapableError } from "../agent/mod.ts";
import { resolveModel, type ResolvedModel } from "../agent/models.ts";
import { handleCommand, type DispatchDeps } from "../commands/dispatch.ts";
import { parseCommand } from "../commands/parse.ts";
import {
  resolveCommand,
  resolveTiming,
  type CommandCompletionResult,
  type SideEffect,
} from "../commands/registry.ts";
import { interruptAndCascade } from "../interrupt.ts";
import { MemoryStore } from "../memory/mod.ts";
import { type ConversationState } from "../sessions/mod.ts";
import { surfaceId, type Surface, type GuestSurface } from "../surface.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { saveAttachment, UnsafeAttachmentNameError, type SavedAttachment } from "./attachments.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { PendingCompletionClaim } from "../delegated-work/mod.ts";
import {
  RuntimeAdmissionFailedBeforeDecisionError,
  type TurnDispatcher,
  type PromptContent,
} from "../orchestration/dispatcher.ts";
import type {
  ConversationCreationLease,
  ConversationLifecycle,
} from "../orchestration/conversation-lifecycle.ts";
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
  /**
   * Decision-0036 pending-claim protocol. Ordinary content interactions and
   * authorized guest summons claim retained durable completions for their
   * exact Surface through the composition-wired completion wake.
   */
  pendingClaim: PendingCompletionClaim;
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

/**
 * Chain a continuation after a runtime admission's completion while
 * preserving the structural decision kind. The structural decision
 * (handoff/busy/fenced/rejected) is already authoritative at the
 * admission call; the continuation runs in the completion so the
 * runtime-admission drain releases immediately and shutdown disposal
 * can cancel a stalled runner creation rather than deadlocking on the
 * admission drain (decision 0046).
 *
 * A rejected admission is terminal: the continuation is not invoked and
 * no follow-on side effects are started from it. The mapped completion
 * settles without consuming the rejected value.
 */
function mapAdmissionCompletion<T>(
  admission: RuntimeAdmissionResult<T>,
  continuation: (value: T) => Promise<void>,
): RuntimeAdmissionResult<void> {
  if (admission.kind === "rejected") {
    // Preserve the rejection as a terminal failure: the continuation is not
    // invoked and the mapped completion rejects so the caller can suppress
    // success delivery. The original completion is observed to avoid
    // unhandled rejections.
    void admission.completion.then(() => undefined, () => undefined);
    return runtimeAdmission.rejected(Promise.reject(new Error("command side-effect rejected after handoff")));
  }
  const completion = admission.completion.then(continuation);
  switch (admission.kind) {
    case "handoff": return runtimeAdmission.handoff(completion);
    case "busy": return runtimeAdmission.busy(completion);
    case "fenced": return runtimeAdmission.fenced(completion);
  }
}

/** Release one lifecycle-issued rejected creation lease with caller context. */
async function releaseRejectedCreation(
  lifecycle: ConversationLifecycle,
  lease: ConversationCreationLease,
  context: string,
): Promise<void> {
  let applied: boolean;
  try {
    applied = await lifecycle.releaseCreation(lease);
  } catch (cause) {
    throw new Error(`failed to release rejected creation lease after ${context}`, { cause });
  }
  if (!applied) {
    throw new Error(
      `creation lease release/rollback was not applied after ${context}; lease was already settled or no safe final rollback mutation applied`,
    );
  }
}

/**
 * Preserve an authoritative structural rejection while attaching creation
 * lease release (and any final authorized rollback) to its completion.
 */
function withRejectedCreationRelease<T>(
  admission: AdmissionResult<T>,
  lease: ConversationCreationLease | null,
  lifecycle: ConversationLifecycle,
  source: string,
): AdmissionResult<T> {
  if (lease === null) return admission;

  const context = `${source} admission (${admission.kind}) for Surface ${lease.surfaceId} and Conversation ${lease.conversationId}`;
  const release = releaseRejectedCreation(lifecycle, lease, context);
  const completion = release.then(
    () => admission.completion,
    async (releaseError: unknown) => {
      try {
        await admission.completion;
      } catch (completionError) {
        throw new AggregateError(
          [releaseError, completionError],
          `Conversation creation release and ${source} admission completion both failed`,
        );
      }
      throw releaseError;
    },
  );
  return { kind: admission.kind, completion };
}

/**
 * Synchronous dispatcher throws happen before a structural decision. Release
 * the observer lease first, then rethrow the admission error; if release or
 * final rollback also fails, preserve both causes in admission-first order.
 */
async function attemptCreationAdmission<T>(
  admit: () => T,
  lease: ConversationCreationLease | null,
  lifecycle: ConversationLifecycle,
  source: string,
): Promise<T> {
  try {
    return admit();
  } catch (admissionError) {
    if (lease === null) throw admissionError;
    const context = `${source} admission throw for Surface ${lease.surfaceId} and Conversation ${lease.conversationId}`;
    try {
      await releaseRejectedCreation(lifecycle, lease, context);
    } catch (releaseError) {
      throw new AggregateError(
        [admissionError, releaseError],
        `Conversation admission and creation release both failed for ${source}`,
      );
    }
    throw admissionError;
  }
}

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
  const { cfg, bot, subagentRunner, memoryStore, dispatcher, lifecycle, pendingClaim } = options;

  /**
   * Claim retained durable completions on an authorized ordinary interaction.
   * Fire-and-forget with observed failures: the claim must never block or
   * fail the user's own turn; a failed claim stays pending for the next one.
   */
  function claimPendingCompletions(surface: Surface): void {
    void pendingClaim.claimForInteraction(surface).catch((err: unknown) => {
      log.error("pending completion claim failed", {
        surfaceId: surfaceId(surface),
        ...boundedError(err),
      });
    });
  }

  /**
   * Claim retained durable completions on an authorized guest summon from
   * this guest Surface. Same fire-and-forget failure posture.
   */
  function claimPendingGuestCompletions(surface: GuestSurface): void {
    void pendingClaim.claimForGuestSummon(surface).catch((err: unknown) => {
      log.error("pending guest summon claim failed", {
        surfaceId: surfaceId(surface),
        ...boundedError(err),
      });
    });
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
    "The current turn is still running after a failed cancel. It recovers automatically once it finishes; use /new or /archive to recover now.";

  /**
   * A wedge only blocks intake while the runtime is observably busy. If
   * the abort timed out but the backend has since settled, the wedge is
   * a stale false positive — clear it and treat the runner as healthy,
   * so the surface recovers on the next message instead of staying
   * locked until /new or /archive.
   */
  function runnerWedged(runner: AgentRunner): boolean {
    return runner.isAbortTimedOut && !runner.tryClearAbortTimeout();
  }

  function tryResolveModel(cfg: Config, modelName: string): ResolvedModel | undefined {
    try {
      return resolveModel({ ...cfg, modelName });
    } catch {
      return undefined;
    }
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
    const applyFrom = async (start: number): Promise<RuntimeAdmissionResult<void> | null> => {
      const completeRemaining = async (next: number): Promise<void> => {
        const remaining = await applyFrom(next);
        if (remaining !== null) {
          await remaining.completion;
          // A later rejected admission in the side-effect chain must suppress
          // the success reply. mapAdmissionCompletion swallows a rejected
          // completion, so the kind is the authoritative signal: throw to
          // turn the rejection into a completion failure that finishCommand's
          // delivery error handler surfaces as "Something went wrong."
          if (remaining.kind === "rejected") {
            throw new Error("command side-effect rejected after handoff");
          }
        }
      };

      for (let index = start; index < sideEffects.length; index++) {
        const effect = sideEffects[index]!;
        if (effect.kind === "runner-created") {
          const admission = dispatcher.admitGetOrCreateRunner(
            effect.conversation,
            effect.surface,
          );
          return mapAdmissionCompletion(admission, () => completeRemaining(index + 1));
        } else if (effect.kind === "runner-disposed") {
          const admission = dispatcher.admitDisposeRunner(effect.conversationId);
          return mapAdmissionCompletion(admission, () => completeRemaining(index + 1));
        } else if (effect.kind === "queue-prompt") {
          // admitPromptTurn enqueues synchronously and acquires the runner
          // inside the queued work, so a stalled creation is cancelled by
          // shutdown disposal rather than deadlocking the admission drain.
          // /queue is instant-timing, so the queue-timing wedge guard never
          // screens it — probe here so a stale wedge (abort timed out but the
          // runtime settled) recovers instead of failing the queued prompt.
          return dispatcher.admitPromptTurn(
            effect.conversation,
            effect.surface,
            (runner, authority) => {
              if (!authority.isCurrent()) return Promise.resolve();
              if (runnerWedged(runner)) {
                return sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
              }
              const buffer = dispatcher.createMessageBuffer(effect.surface, effect.conversation);
              return runner.prompt(message.prepare(effect.text), buffer);
            },
            (err) => {
              log.error("queued prompt failed", {
                error: err instanceof Error ? err.message : String(err),
                sessionId: effect.conversation.id,
              });
            },
          );
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
        // A wedge marked after this command was accepted may be stale by the
        // time the chain drains: deferred commands run once the turn settles,
        // and a settled turn proves the abort timeout was a false positive.
        // Clear it so the command executes on the recovered runtime instead
        // of failing with recovery guidance (issue #50 review finding).
        dispatcher.getRunner(session.id)?.tryClearAbortTimeout();
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
    if (decision.kind === "fenced") {
      log.warn("steer fenced: runtime no longer current", { sessionId: session.id });
      return runtimeAdmission.fenced(undefined);
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
    // lazily create a conversation on the surface, just like text. Lifecycle
    // supplies the only lease capable of participating in creation settlement.
    const resolution = await lifecycle.resolveOrStart(surface);
    const conversation = resolution.conversation;
    const creationLease = resolution.creationLease;
    const session = conversation;
    claimPendingCompletions(surface);

    return {
      surface,
      session,
      environment: conversation.executionEnvironment,
      schedule: async (run, failureLog, opts) => {
        let admittedRunner: AgentRunner | undefined;
        const execute = async (runner: AgentRunner, authority: WorkAuthority): Promise<void> => {
          admittedRunner = runner;
          if (runnerWedged(runner)) {
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

        // A wedged runner is an adapter-local completion: no runtime work
        // is attempted. Check synchronously via the registered runner to
        // avoid awaiting runner acquisition.
        const existingRunner = dispatcher.getRunner(session.id);
        if (existingRunner !== null && runnerWedged(existingRunner)) {
          if (creationLease !== null) lifecycle.sealCreation(creationLease);
          return completed(sendSystemReply(message, WEDGED_RUNNER_REPLY, "error"));
        }
        // admitPromptTurn enqueues the work synchronously and acquires
        // the runner inside the queued work when no runner is registered
        // yet, so a stalled creation is cancelled by shutdown disposal
        // rather than deadlocking the runtime-admission drain.
        const admission = await attemptCreationAdmission(
          () => dispatcher.admitPromptTurn(
            session,
            surface,
            execute,
            onError,
          ),
          creationLease,
          lifecycle,
          kind,
        );
        if (admission.kind !== "rejected") {
          if (creationLease !== null) lifecycle.sealCreation(creationLease);
          return admission;
        }
        return withRejectedCreationRelease(admission, creationLease, lifecycle, kind);
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
    // Ordinary content must join a still-pending lazy creation through
    // resolveOrStart rather than observing it through the sealing inspect API.
    const existingConversation = command !== null ? lifecycle.inspect(surface) : null;
    if (command !== null && command !== "/new" && def === null) {
      // Unknown commands are adapter-owned completions, not runtime work
      // (decision 0046). Handle locally for both active and inactive
      // conversations: no runner is prompted and no model turn starts.
      const delivery = surface.kind === "guest"
        ? Promise.resolve()
        : existingConversation
          ? sendSystemReply(message, "Unknown command. Use /help to see available commands.", "info", { propagateErrors: true })
          : surface.kind === "dm"
            ? replyNoActiveSession(message, surface, "text")
            : Promise.resolve();
      return completed(delivery);
    }

    if (command !== null) {
      const session = existingConversation ?? null;
      const existingRunner = session ? dispatcher.getRunner(session.id) : null;

      function getSideEffectWriter(
        sideEffects: SideEffect[],
      ): { conversation: ConversationState; runner: AgentRunner | null } | null {
        for (let index = sideEffects.length - 1; index >= 0; index--) {
          const effect = sideEffects[index]!;
          if (effect.kind === "runner-created") {
            return { conversation: effect.conversation, runner: dispatcher.getRunner(effect.conversation.id) };
          }
        }
        return null;
      }

      const finishCommand = async (
        result: CommandCompletionResult,
        opts?: { skipSideEffects?: boolean },
      ): Promise<AdmissionResult<void>> => {
        if (result.kind === "fallthrough") return completed(undefined);
        const sideEffectAdmission = opts?.skipSideEffects
          ? null
          : await applySideEffects(result.sideEffects, message);
        const queueRejected = sideEffectAdmission?.kind === "rejected" &&
          result.sideEffects.some((effect) => effect.kind === "queue-prompt");
        const delivery = sideEffectAdmission?.completion.then(
          async () => {
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
          },
          async (err: unknown) => {
            // A side-effect completion failure (e.g. runner preparation
            // rejected after /new created a durable conversation) must still
            // produce a user-visible error reply. The structural decision
            // was already recorded; rethrowing propagates the completion
            // failure without rewriting it (decision 0046).
            log.error("command side-effect completion failed", {
              error: String(err),
              command,
              sessionId: session?.id,
            });
            const replyText = "Something went wrong. Please try again.";
            await sendSystemReply(message, replyText, "error");
            const writer = getSideEffectWriter(result.sideEffects) ??
              (session ? { conversation: session, runner: existingRunner } : null);
            if (writer?.runner) {
              recordAssistantReply(writer.conversation.id, surface, writer.runner, replyText);
            }
            throw err;
          },
        ) ?? (
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

      const timing = resolveTiming(def, rawText ?? "");
      const runnerIsWedged = existingRunner !== null && runnerWedged(existingRunner);
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

      if (recoverWedgedRuntime) {
        // A wedged runtime needs a lifecycle/runtime-owned recovery admission:
        // record the structural handoff synchronously and carry the disposal
        // and replacement in the completion (decision 0046). Awaiting the
        // lifecycle call directly would hold the runtime-admission drain while
        // disposal runs, so recovery uses machine-held Binding authority.
        return dispatcher.admitConversationControl(surface, session, async (authority) => {
          if (!authority.isCurrent()) return;
          const commandResult = await handleCommand({
            command,
            deps: dispatchDeps,
            rawText: rawText ?? "",
            surface,
            conversation: session,
            existingRunner,
            bot,
          });
          if (commandResult.kind === "fallthrough") return;
          // /new and /archive deliberately rotate their own Binding. Other
          // recovery work must still hold the captured Binding authority
          // before committing command completion effects.
          if (!authority.isCurrent() && def?.name !== "new" && def?.name !== "archive") return;
          if (commandResult.kind === "admission") {
            const resolved = await commandResult.admission.completion;
            const finished = await finishCommand(
              resolved,
              commandResult.admission.kind === "rejected" ? { skipSideEffects: true } : undefined,
            );
            await finished.completion;
            return;
          }
          const finished = await finishCommand(commandResult);
          await finished.completion;
        });
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
        if (commandResult.kind === "admission") {
          const admission = commandResult.admission;
          if (admission.kind === "rejected") {
            // A rejected command admission is terminal: no follow-on side
            // effects are started from it. The completion may still carry a
            // reply (e.g. /revive's failure reply), so finishCommand runs
            // with skipSideEffects to deliver the reply without applying
            // any side-effect admissions (decision 0046).
            const completion = admission.completion.then(
              async (result) => {
                const finished = await finishCommand(result, { skipSideEffects: true });
                if (finished.kind !== "completed") {
                  throw new Error("admitted command attempted a second runtime admission");
                }
                await finished.completion;
              },
              async (err: unknown) => {
                log.error("command admission failed", { error: String(err), command, sessionId: session?.id });
                const replyText = "Something went wrong. Please try again.";
                await sendSystemReply(message, replyText, "error");
                if (session) recordAssistantReply(session.id, surface, existingRunner, replyText);
                throw err;
              },
            );
            return runtimeAdmission.rejected(completion);
          }
          const completion = admission.completion.then(
            async (result) => {
              const finished = await finishCommand(result);
              // The command's structural admission remains authoritative.
              // Lifecycle-owned work such as an unbound /resume may attach a
              // follow-on runner side effect after its binding transition
              // completes; that nested admission contributes completion only.
              await finished.completion;
            },
            async (err: unknown) => {
              log.error("command admission failed", { error: String(err), command, sessionId: session?.id });
              const replyText = "Something went wrong. Please try again.";
              await sendSystemReply(message, replyText, "error");
              if (session) recordAssistantReply(session.id, surface, existingRunner, replyText);
              throw err;
            },
          );
          switch (admission.kind) {
            case "handoff": return runtimeAdmission.handoff(completion);
            case "busy": return runtimeAdmission.busy(completion);
            case "fenced": return runtimeAdmission.fenced(completion);
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

    const resolution = await lifecycle.resolveOrStart(surface);
    const conversation = resolution.conversation;
    const creationLease = resolution.creationLease;
    const session = conversation;
    claimPendingCompletions(surface);
    if (!rawText) {
      if (creationLease !== null) lifecycle.sealCreation(creationLease);
      return completed(undefined);
    }

    // Use the registered runner directly for synchronous steer/wedge checks
    // without awaiting runner acquisition. For an idle runner or when no
    // runner is registered, admitPromptTurn enqueues the work synchronously
    // and acquires the runner inside the queued work, so a stalled creation
    // is cancelled by shutdown disposal rather than deadlocking the
    // runtime-admission drain (decision 0046).
    const existingRunner = dispatcher.getRunner(session.id);
    if (existingRunner !== null) {
      if (runnerWedged(existingRunner)) {
        if (creationLease !== null) lifecycle.sealCreation(creationLease);
        return completed(sendSystemReply(message, WEDGED_RUNNER_REPLY, "error"));
      }
      if (existingRunner.isStreaming) {
        if (creationLease !== null) lifecycle.sealCreation(creationLease);
        return steerOrFallbackToFreshTurn(message, surface, session, existingRunner, rawText);
      }
    }
    const admission = await attemptCreationAdmission(
      () => dispatcher.admitPromptTurn(
        session,
        surface,
        async (runner, authority) => {
          if (runnerWedged(runner)) {
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
      ),
      creationLease,
      lifecycle,
      "text",
    );
    if (admission.kind !== "rejected") {
      if (creationLease !== null) lifecycle.sealCreation(creationLease);
      return admission;
    }
    return withRejectedCreationRelease(admission, creationLease, lifecycle, "text");
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
    let creationLease: ConversationCreationLease | null;
    try {
      const resolution = await lifecycle.resolveOrStart(surface);
      conversation = resolution.conversation;
      creationLease = resolution.creationLease;
    } catch (error) {
      log.error("guest resolve failed", { error: String(error), surfaceId: surfaceId(surface) });
      return completed(replyOnce(errorArticle(), "guest error reply failed"));
    }

    // The guest query itself is the authorized summon: retained completions
    // for this exact guest Surface claim alongside the summoned turn.
    claimPendingGuestCompletions(surface);

    const sink = new GuestReplySink();
    const admission = await attemptCreationAdmission(
      () => dispatcher.admitImmediateTurn(
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
      ),
      creationLease,
      lifecycle,
      "guest",
    );

    let rejectedAdmission: RuntimeAdmissionResult<void>;
    switch (admission.kind) {
      case "accepted": {
        if (creationLease !== null) lifecycle.sealCreation(creationLease);
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
        rejectedAdmission = runtimeAdmission.busy(replyOnce(busyArticle(), "guest busy reply failed"));
        break;
      case "closed":
        rejectedAdmission = runtimeAdmission.rejected(undefined);
        break;
      case "fenced":
        rejectedAdmission = runtimeAdmission.fenced(undefined);
        break;
    }
    return withRejectedCreationRelease(rejectedAdmission, creationLease, lifecycle, "guest");
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
