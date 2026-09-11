import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { AgentRunner } from "../agent/mod.ts";
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
import type { McpRunner } from "../mcp/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import { type ConversationState } from "../sessions/mod.ts";
import { surfaceId, type Surface } from "../surface.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import {
  RuntimeAdmissionFailedBeforeDecisionError,
  type TurnDispatcher,
} from "../orchestration/dispatcher.ts";
import {
  completed,
  runtimeAdmission,
  type AdmissionResult,
  type RuntimeAdmissionResult,
} from "../shutdown/mod.ts";
import { sendSystemReply } from "./format.ts";
import type { TelegramIntakeMessage } from "./intake.ts";
import {
  attemptCreationAdmission,
  mapAdmissionCompletion,
  withRejectedCreationRelease,
} from "./intake-admission.ts";
import {
  claimPendingCompletions,
  recordAssistantReply,
  runnerWedged,
  WEDGED_RUNNER_REPLY,
  type IntakeDeps,
} from "./intake-turn.ts";

/**
 * The explicit dependency bag the text/command orchestration core receives
 * instead of closing over `createTelegramIntake` locals.
 */
export interface TextIntakeDeps extends IntakeDeps {
  bot: Bot;
  subagentRunner: SubagentRunner;
  scheduleStore?: ScheduleStore;
  mcpRunner?: McpRunner;
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

/**
 * Command replies may carry raw Telegram reply_markup (Settings web_app
 * keyboard); pass it through to the sender when present.
 */
function commandReplyOpts(result: CommandCompletionResult): { reply_markup?: unknown } {
  return result.kind === "replied" && result.replyMarkup !== undefined
    ? { reply_markup: result.replyMarkup }
    : {};
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
export async function applySideEffects(
  dispatcher: TurnDispatcher,
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
 * Build the `handleText` port handler: text messages and slash-command
 * orchestration, including dispatch ordering, wedge probing/recovery,
 * deferred command scheduling, and side-effect delivery.
 */
export function createTextHandler(deps: TextIntakeDeps) {
  const { cfg, bot, subagentRunner, dispatcher, lifecycle, pendingClaim } = deps;

  const dispatchDeps: DispatchDeps = {
    lifecycle,
    subagentRunner,
    cfg,
    tryResolveModel,
    interruptAndCascade,
    scheduleStore: deps.scheduleStore,
    dispatcher,
    mcpRunner: deps.mcpRunner,
  };

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
          invokingUserId: message.invokingUserId,
          conversation: session,
          existingRunner: dispatcher.getRunner(session.id),
          bot,
        });
        // Queue-timing commands cannot attach delegated work.
        if (result.kind === "fallthrough") return;
        if (result.kind === "admission") {
          throw new Error(`queue-timing command ${command} returned delegated admission`);
        }
        const sideEffectAdmission = await applySideEffects(dispatcher, result.sideEffects, message);
        if (sideEffectAdmission !== null) {
          await sideEffectAdmission.completion;
        }
        if (result.kind === "replied") {
          await sendSystemReply(message, result.reply, result.tag ?? "ok", commandReplyOpts(result));
        }
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("deferred command failed", { error: msg, command, sessionId: session.id });
        const replyText = `/${command} failed after the turn: ${msg}`;
        await sendSystemReply(message, replyText, "error").catch(() => {});
        const currentRunner = dispatcher.getRunner(session.id);
        recordAssistantReply(cfg, session.id, surface, currentRunner, replyText);
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
          : await applySideEffects(dispatcher, result.sideEffects, message);
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
              await sendSystemReply(message, result.reply, result.tag ?? "ok", commandReplyOpts(result));
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
              recordAssistantReply(cfg, writer.conversation.id, surface, writer.runner, replyText);
            }
            throw err;
          },
        ) ?? (
          result.kind === "replied"
            ? sendSystemReply(message, result.reply, result.tag ?? "ok", commandReplyOpts(result))
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
            invokingUserId: message.invokingUserId,
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
          invokingUserId: message.invokingUserId,
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
                if (session) recordAssistantReply(cfg, session.id, surface, existingRunner, replyText);
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
              if (session) recordAssistantReply(cfg, session.id, surface, existingRunner, replyText);
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
          if (session) recordAssistantReply(cfg, session.id, surface, existingRunner, replyText);
        });
        return completed(delivery);
      }
    }

    const resolution = await lifecycle.resolveOrStart(surface);
    const conversation = resolution.conversation;
    const creationLease = resolution.creationLease;
    const session = conversation;
    claimPendingCompletions(pendingClaim, surface);
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

  return handleText;
}
