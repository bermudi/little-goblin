import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Bot, Context } from "grammy";
import type { Config } from "../config.ts";
import { boundedError, log } from "../log.ts";
import type { Surface, ConversationState, ConversationId } from "../sessions/mod.ts";
import { surfaceId } from "../surface.ts";
import {
  BindingFencedError,
  type ConversationLifecycle,
} from "../orchestration/conversation-lifecycle.ts";

import type { AgentRunner } from "../agent/mod.ts";
import type { ResolvedModel } from "../agent/models.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import type { TurnDispatcher } from "../orchestration/dispatcher.ts";
import type { WorkAuthority } from "../orchestration/conversation-runtime-host.ts";
import { projectRootOf } from "../sessions/environment.ts";
import { DEFAULT_CASCADE_TIMEOUT_MS, interruptAndCascade } from "../interrupt.ts";
import { generateDiagnostics } from "../diagnostics.ts";
import { cancelReply } from "./cancel.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeProject } from "./project.ts";
import { executeModel } from "./model.ts";
import { executeCompact } from "./compact.ts";
import { executeName } from "./name.ts";
import { executeResume, selectResumeConversation, type ResumeCommandResult } from "./resume.ts";
import { executeThink, ALL_LEVELS } from "./think.ts";
import { parseCommandArg } from "./parse.ts";
import {
  CANCEL_SUBAGENT_USAGE_REPLY,
  formatSubagentsList,
  parseReviveSubagentArgs,
  parseSubagentId,
  REVIVE_SUBAGENT_USAGE_REPLY,
} from "./subagents.ts";
import { executeVoice } from "./voice.ts";
import { pingHandler } from "./ping.ts";
import { buildStartHandler } from "./start.ts";
import { buildScheduleDeps, executeSchedule } from "./schedule.ts";
import {
  formatSkillsStatus,
  formatSkillsTransition,
  parseSkillsCommand,
} from "./skills.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import {
  completed,
  runtimeAdmission,
  type AdmissionResult,
} from "../shutdown/mod.ts";
import type { SystemTag } from "../tg/format.ts";

// ---------------------------------------------------------------------------
// Shared dispatch types (owned by the registry; re-exported by dispatch.ts)
// ---------------------------------------------------------------------------

export type SideEffect =
  | { kind: "runner-created"; conversation: ConversationState; surface: Surface }
  | { kind: "runner-disposed"; conversationId: string }
  | { kind: "queue-prompt"; conversation: ConversationState; surface: Surface; text: string };

export type CommandCompletionResult =
  | { kind: "replied"; reply: string; tag?: SystemTag; sideEffects: SideEffect[] }
  | { kind: "handled"; sideEffects: SideEffect[] }
  | { kind: "fallthrough" };

export type DispatchResult = CommandCompletionResult | {
  kind: "admission";
  admission: AdmissionResult<CommandCompletionResult>;
};

export interface DispatchDeps {
  /** Deep conversation lifecycle; commands mutate bindings through this seam. */
  lifecycle: ConversationLifecycle;
  subagentRunner: SubagentRunner;
  cfg: Config;
  tryResolveModel: (cfg: Config, modelName: string) => ResolvedModel | undefined;
  interruptAndCascade: typeof interruptAndCascade;
  /**
   * Schedule store for `/schedule`. Optional so callers that don't wire
   * scheduling (e.g. unit tests of other commands) still satisfy the type.
   * The `/schedule` handler returns a usage reply when this is absent.
   */
  scheduleStore?: ScheduleStore;
  /** Runtime/delegated-work authority owner for command admissions. */
  dispatcher: TurnDispatcher;
  /**
   * External agent runner, used by `/cancel` to cascade-cancels external runs
   * owned by the session. Optional for callers that test command handling in
   * isolation.
   */
  externalAgentRunner?: ExternalAgentRunner;
}

export interface DispatchOpts {
  command: string;
  deps: DispatchDeps;
  rawText: string;
  surface: Surface;
  conversation: ConversationState | null;
  existingRunner: AgentRunner | null;
  bot?: Bot;
}

export type CommandHandler = (opts: DispatchOpts) => Promise<DispatchResult>;

export type GrammyHandlerFactory = (deps: {
  lifecycle: ConversationLifecycle;
}) => (ctx: Context) => Promise<void>;

// ---------------------------------------------------------------------------
// CommandDef
// ---------------------------------------------------------------------------

/**
 * When a command runs relative to an in-flight turn.
 *
 * - `"instant"` — runs immediately, never touches the in-flight turn. Used by
 *   read-only commands (lists, diagnostics) and commands whose effect is
 *   independent of the runner's streaming state.
 * - `"queue"` — if the runner is streaming, the command is deferred: the user
 *   gets an instant "Queued." ack, and the command runs (with a follow-up
 *   reply) once the turn settles naturally. If the runner is idle, runs
 *   immediately. Used by state-mutating commands whose effects want the
 *   runner idle (model switch, project rebind, archive, etc.).
 * - `"interrupt"` — aborts the in-flight turn via `interruptAndCascade` before
 *   running. Reserved for `/cancel`, whose entire semantics is "stop now."
 *
 * A function form lets a single command vary its timing by argument — e.g.
 * `/model` (list) is instant, `/model 2` (switch) is queue.
 */
export type CommandTiming = "instant" | "queue" | "interrupt";

export interface CommandDef {
  /** Canonical name without leading slash, e.g. "cancel". */
  name: string;
  /** Human-readable description shown in /help and the Telegram menu. */
  description: string;
  /** Alternative names (without slash). */
  aliases?: readonly string[];
  /** Argument placeholder shown in help, e.g. "<name>" or "[index]". */
  argsHint?: string;
  /**
   * When this command runs relative to an in-flight turn. Defaults to
   * `"instant"`. See {@link CommandTiming}.
   */
  timing?: CommandTiming | ((rawText: string) => CommandTiming);
  /**
   * This queue-timing command owns a lifecycle transition that invalidates a
   * broken runtime, so it may run directly after that runtime's abort timed
   * out. All other queue-timing commands must report the recovery guidance
   * rather than queue work behind an unrecoverable runtime.
   */
  mayRecoverWedgedRuntime?: boolean;
  /** Dispatched from the message:text handler. Mutually exclusive with grammyHandler. */
  handler?: CommandHandler;
  /** Registered via bot.command(). Mutually exclusive with handler. */
  grammyHandler?: GrammyHandlerFactory;
}

// ---------------------------------------------------------------------------
// Helpers shared by handlers
// ---------------------------------------------------------------------------

function replied(reply: string, sideEffects: SideEffect[] = [], tag?: SystemTag): CommandCompletionResult {
  return { kind: "replied", reply, sideEffects, tag };
}

/**
 * A rejected command admission carries no reply and no side effects. The
 * cancel/cancel_subagent handlers map the rejected completion to this no-op
 * result so `finishCommand` processes a valid `CommandCompletionResult`
 * without sending a reply or starting follow-on work (decision 0046).
 */
function noopCommandCompletion(): CommandCompletionResult {
  return { kind: "handled", sideEffects: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function preferenceTransitionReply(reply: string, cleanupError?: string): string {
  if (cleanupError === undefined) return reply;
  const detail = boundedError(cleanupError, 160).error;
  return `${reply}\nPreference saved, but runtime cleanup reported an error after invalidation: ${detail}`;
}

// ---------------------------------------------------------------------------
// Handler functions — one per dispatched command. These wrap the existing
// execute* helpers and carry over the side-effect logic from the former
// dispatch.ts switch verbatim.
// ---------------------------------------------------------------------------

const cancelHandler: CommandHandler = async ({ deps, surface, conversation, existingRunner }) => {
  // /cancel is the sole interrupter: it aborts the in-flight turn itself,
  // rather than relying on a dispatch pre-check. The cascade result drives
  // the honest reply ("Cancelled." vs "Nothing to cancel." vs timeout suffix).
  // If there is a queued-but-not-yet-started prompt (e.g. a coalescer flush
  // that has scheduled but not yet started), cancel it first so the reply
  // reflects the work that was actually stopped.
  //
  // Without a bound conversation, /cancel has no scope to interrupt.
  // Returning early avoids the process-wide cascade that interruptAndCascade
  // performs when no conversation id is supplied (interrupt.ts:142-146).
  if (conversation === null) return replied("Nothing to cancel.", [], "info");
  // The admission classification and the start of cancellation work are one
  // atomic step: admitConversationControl invokes the callback synchronously when
  // admission is open, and does not invoke it when rejected. A rejected
  // admission starts no cancellation dependency (decision 0046).
  const runCancellation = (authority: WorkAuthority): Promise<CommandCompletionResult> => {
    if (!authority.isCurrent()) return Promise.resolve(noopCommandCompletion());
    const cancelledPending = deps.dispatcher.cancelPending(conversation.id);
    return deps.interruptAndCascade(
      existingRunner,
      deps.subagentRunner,
      DEFAULT_CASCADE_TIMEOUT_MS,
      conversation.id,
      deps.externalAgentRunner,
    ).then((cascade) => {
      if (!authority.isCurrent()) return noopCommandCompletion();
      if (cancelledPending) cascade.attemptedMain = true;
      const tag: SystemTag = cascade.wedgedMain
        ? "error"
        : cascade.attemptedMain || cascade.attemptedSubagents > 0 || cascade.attemptedExternalAgents > 0
        ? "ok"
        : "info";
      return replied(cancelReply({
        cascade,
        cascadeTimeoutMs: DEFAULT_CASCADE_TIMEOUT_MS,
      }), [], tag);
    });
  };
  const admission = deps.dispatcher.admitConversationControl(surface, conversation, runCancellation);
  switch (admission.kind) {
    case "handoff": return { kind: "admission", admission: runtimeAdmission.handoff(admission.completion) };
    case "busy": return { kind: "admission", admission: runtimeAdmission.busy(admission.completion) };
    case "fenced": return {
      kind: "admission",
      admission: runtimeAdmission.fenced(
        admission.completion.then(noopCommandCompletion, noopCommandCompletion),
      ),
    };
    case "rejected": return {
      kind: "admission",
      admission: runtimeAdmission.rejected(
        admission.completion.then(noopCommandCompletion, noopCommandCompletion),
      ),
    };
  }
};

const newHandler: CommandHandler = async ({ deps, surface, conversation }) => {
  const { lifecycle } = deps;
  const sideEffects: SideEffect[] = [];
  const priorConversation = conversation;
  try {
    const result = await executeNew({ createConversation: () => lifecycle.rotate(surface) });
    if (priorConversation) sideEffects.push({ kind: "runner-disposed", conversationId: priorConversation.id });
    sideEffects.push({ kind: "runner-created", conversation: result.conversation, surface });
    return replied(result.reply, sideEffects, "ok");
  } catch (err) {
    log.error("new conversation creation failed", { error: String(err), sessionId: priorConversation?.id });
    return replied("Failed to reset conversation. Please try again.", [], "error");
  }
};

const archiveHandler: CommandHandler = async ({ deps, surface, conversation: activeConversation }) => {
  const { lifecycle } = deps;
  try {
    const result = await executeArchive({
      archive: () => lifecycle.archive(surface),
    });
    const tag: SystemTag = result.kind === "archived" ? "ok" : "info";
    const sideEffects: SideEffect[] = result.kind === "archived" && activeConversation !== null
      ? [{ kind: "runner-disposed", conversationId: activeConversation.id }]
      : [];
    return replied(result.reply, sideEffects, tag);
  } catch (err) {
    log.error("archive failed", { error: String(err), sessionId: activeConversation?.id });
    return replied("Failed to archive conversation. Please try again.", [], "error");
  }
};

const projectHandler: CommandHandler = async ({ deps, surface, rawText }) => {
  const { lifecycle } = deps;
  try {
    const result = await executeProject({
      rawText,
      assignProject: (canonicalRoot) => lifecycle.assignProject(surface, canonicalRoot),
    });
    const sideEffects: SideEffect[] = [];
    if (result.kind === "assigned") {
      if (result.previousConversationId) {
        sideEffects.push({ kind: "runner-disposed", conversationId: result.previousConversationId });
      }
      sideEffects.push({ kind: "runner-created", conversation: result.conversation, surface });
    }
    const tag: SystemTag =
      result.kind === "assigned" || result.kind === "already-assigned" ? "ok"
      : result.kind === "missing-arg" ? "info"
      : result.kind === "bad-path" || result.kind === "conflict" || result.kind === "rejected" ? "warn"
      : "error";
    return replied(result.reply, sideEffects, tag);
  } catch (err) {
    const sessionId = deps.lifecycle.inspect(surface)?.id;
    log.error("project failed", { error: String(err), sessionId });
    return replied("Failed to assign project. Please try again.", [], "error");
  }
};

const modelHandler: CommandHandler = async ({ deps, surface, rawText }) => {
  const { cfg } = deps;
  try {
    const surfaceModelName = deps.lifecycle.settings.getModelName(surface);
    const surfaceThinkingLevel = deps.lifecycle.settings.getThinkingLevel(surface);
    const currentModelName = surfaceModelName ?? cfg.modelName;
    const currentThinkingLevel = surfaceThinkingLevel;
    const currentResolvedModel = deps.tryResolveModel(cfg, currentModelName);
    const result = executeModel({
      rawText,
      favorites: cfg.favorites,
      cfg,
      currentModelName,
      currentThinkingLevel,
      currentResolvedModel,
    });
    if (result.kind === "set" || result.kind === "cleared") {
      const patch: { modelName?: string | undefined; thinkingLevel?: ThinkingLevel | undefined } = {};
      patch.modelName = result.kind === "set" ? result.modelName : undefined;
      if (result.thinkingClamped !== undefined) {
        patch.thinkingLevel = result.thinkingClamped;
      }
      const transition = await deps.lifecycle.setSurfacePreferences(surface, patch);
      const tag: SystemTag = transition.cleanupError ? "warn" : "ok";
      return replied(preferenceTransitionReply(result.reply, transition.cleanupError), [], tag);
    }
    const tag: SystemTag = result.kind === "no-favorites" || result.kind === "bad-index" || result.kind === "bad-model" ? "warn" : "info";
    return replied(result.reply, [], tag);
  } catch (err) {
    log.error("model failed", { error: String(err), surfaceId: surfaceId(surface) });
    return replied("Failed to switch model. Please try again.", [], "error");
  }
};

const thinkHandler: CommandHandler = async ({ deps, surface, rawText }) => {
  const { cfg } = deps;
  try {
    const surfaceModelName = deps.lifecycle.settings.getModelName(surface);
    const surfaceThinkingLevel = deps.lifecycle.settings.getThinkingLevel(surface);
    const currentModelName = surfaceModelName ?? cfg.modelName;
    const currentResolvedModel = deps.tryResolveModel(cfg, currentModelName);
    const supportedLevels = currentResolvedModel
      ? (getSupportedThinkingLevels(currentResolvedModel.model) as readonly ThinkingLevel[])
      : ALL_LEVELS;
    const requestedLevel = surfaceThinkingLevel ?? currentResolvedModel?.thinkingLevel ?? "medium";
    const result = executeThink({
      rawText,
      // The "current" level must be one the model actually supports: a stored
      // override or the model default may name a level the active model cannot
      // use (pi clamps it to the nearest supported level at request time), so
      // clamp here for an honest display.
      currentLevel: currentResolvedModel
        ? clampThinkingLevel(currentResolvedModel.model, requestedLevel)
        : requestedLevel,
      supportedLevels,
    });
    if (result.kind === "set" || result.kind === "cleared") {
      const patch: { thinkingLevel?: ThinkingLevel | undefined } = {};
      patch.thinkingLevel = result.kind === "set" ? result.level : undefined;
      const transition = await deps.lifecycle.setSurfacePreferences(surface, patch);
      const tag: SystemTag = transition.cleanupError ? "warn" : "ok";
      return replied(preferenceTransitionReply(result.reply, transition.cleanupError), [], tag);
    }
    const tag: SystemTag = result.kind === "bad-level" ? "warn" : "info";
    return replied(result.reply, [], tag);
  } catch (err) {
    log.error("think failed", { error: String(err), surfaceId: surfaceId(surface) });
    return replied("Failed to set thinking level. Please try again.", [], "error");
  }
};

const debugHandler: CommandHandler = async ({ deps, conversation, existingRunner, surface }) => {
  const { cfg, subagentRunner } = deps;
  if (!conversation) return replied("No active conversation.", [], "info");
  const surfaceModelName = deps.lifecycle.settings.getModelName(surface);
  const surfaceThinkingLevel = deps.lifecycle.settings.getThinkingLevel(surface);
  const diag = generateDiagnostics({
    conversation,
    runner: existingRunner,
    subagentRunner,
    goblinHome: cfg.goblinHome,
    modelName: surfaceModelName ?? cfg.modelName,
    thinkingLevel: surfaceThinkingLevel,
    projectDir: projectRootOf(conversation.executionEnvironment) ?? undefined,
  });
  return replied(diag, [], "info");
};

const compactHandler: CommandHandler = async ({ conversation, existingRunner, rawText }) => {
  try {
    const result = await executeCompact({ hasSession: conversation !== null, rawText, runner: existingRunner });
    const tag: SystemTag = result.kind === "compacted" ? "ok"
      : result.kind === "failed" ? "error"
      : "info";
    return replied(result.reply, [], tag);
  } catch (err) {
    log.error("compact failed", { error: String(err), sessionId: conversation?.id });
    return replied("Failed to compact conversation. Please try again.", [], "error");
  }
};

const nameHandler: CommandHandler = async ({ deps, conversation, surface, rawText }) => {
  const { lifecycle } = deps;
  try {
    const result = await executeName({
      rawText,
      setTitle: (title) => lifecycle.setTitle(surface, title),
    });
    const tag: SystemTag = result.kind === "renamed" ? "ok" : "info";
    return replied(result.reply, [], tag);
  } catch (err) {
    log.error("name failed", { error: String(err), sessionId: conversation?.id });
    return replied("Failed to name conversation. Please try again.", [], "error");
  }
};

const resumeHandler: CommandHandler = async ({ deps, surface, conversation: activeConversation, rawText }) => {
  const { lifecycle } = deps;
  const finishResume = (result: ResumeCommandResult): CommandCompletionResult => {
    const sideEffects: SideEffect[] = [];
    if (result.kind === "resumed" && result.conversation.id !== activeConversation?.id) {
      // Displace the destination's prior runtime (if any) and invalidate any
      // stale runner keyed by the resumed conversation before creating a fresh
      // runtime for the destination surface.
      if (activeConversation) sideEffects.push({ kind: "runner-disposed", conversationId: activeConversation.id });
      sideEffects.push({ kind: "runner-disposed", conversationId: result.conversation.id });
      sideEffects.push({ kind: "runner-created", conversation: result.conversation, surface });
    }
    const tag: SystemTag = result.kind === "resumed" ? "ok"
      : result.kind === "not-found" || result.kind === "ambiguous" || result.kind === "incompatible" ? "warn"
      : "info";
    return replied(result.reply, sideEffects, tag);
  };

  try {
    const { compatible, incompatible } = await lifecycle.getResumeCandidates(surface);

    // A bound Surface is already admitted through the runtime's queued
    // Binding-authority path. An unbound Surface has no runtime machine, so
    // lifecycle must record ownership synchronously before disposal can
    // stall. Return that admission separately from its completion so the
    // Telegram update receives its structural handoff immediately.
    if (activeConversation === null) {
      const selection = selectResumeConversation({
        rawText,
        conversations: compatible,
        incompatibleConversations: incompatible,
      });
      if (selection.kind !== "selected") return finishResume(selection);

      const admitted = lifecycle.admitResume(surface, selection.conversation.id as ConversationId);
      const completion = admitted.completion.then(
        (conversation) => finishResume({
          kind: "resumed",
          conversation,
          reply: `Resumed conversation \`${conversation.id}\`${conversation.title ? ` — ${conversation.title}` : ""}`,
        }),
        (err: unknown) => {
          log.error("resume failed", { error: String(err), sessionId: undefined });
          return replied("Failed to resume conversation. Please try again.", [], "error");
        },
      );
      return { kind: "admission", admission: runtimeAdmission.handoff(completion) };
    }

    const bindConversation = (conversationId: string): Promise<ConversationState> =>
      lifecycle.resume(surface, conversationId as ConversationId);
    const result = await executeResume({
      rawText,
      conversations: compatible,
      incompatibleConversations: incompatible,
      bindConversation,
    });
    return finishResume(result);
  } catch (err) {
    log.error("resume failed", { error: String(err), sessionId: activeConversation?.id });
    return replied("Failed to resume conversation. Please try again.", [], "error");
  }
};

const subagentsHandler: CommandHandler = async ({ deps, conversation }) => {
  const infos = conversation === null ? [] : deps.subagentRunner.list(conversation.id);
  return replied(formatSubagentsList(infos), [], "info");
};

const cancelSubagentHandler: CommandHandler = async ({ deps, rawText, surface, conversation }) => {
  const id = parseSubagentId(rawText);
  if (id === null) return replied(CANCEL_SUBAGENT_USAGE_REPLY, [], "info");
  if (conversation === null) return replied("No active conversation.", [], "info");
  // Delegated cancellation is classified by the dispatcher (runtime host);
  // the command maps the result and attaches reply delivery (decision 0046).
  // The conversation-control admission invokes cancellation synchronously when admission is
  // open and does not invoke it when rejected, so a closed gate starts no
  // subagent cancellation.
  const admission = deps.dispatcher.admitCancelSubagent(surface, conversation, id);
  const cancellationCompletion = admission.completion.then(
    () => replied(`Cancelled subagent \`${id}\`.`, [], "ok"),
    (err: unknown) => {
      if (err instanceof BindingFencedError) return noopCommandCompletion();
      const message = errorMessage(err);
      log.error("cancel_subagent failed", { id, error: message });
      return replied(`Failed to cancel subagent \`${id}\`: ${message}`, [], "error");
    },
  );
  switch (admission.kind) {
    case "handoff": return { kind: "admission", admission: runtimeAdmission.handoff(cancellationCompletion) };
    case "busy": return { kind: "admission", admission: runtimeAdmission.busy(cancellationCompletion) };
    case "fenced": return {
      kind: "admission",
      admission: runtimeAdmission.fenced(
        admission.completion.then(noopCommandCompletion, noopCommandCompletion),
      ),
    };
    case "rejected": return {
      kind: "admission",
      admission: runtimeAdmission.rejected(admission.completion.then(
        noopCommandCompletion,
        (err: unknown) => {
          if (err instanceof BindingFencedError) return noopCommandCompletion();
          const message = errorMessage(err);
          log.error("cancel_subagent failed", { id, error: message });
          return replied(`Failed to cancel subagent \`${id}\`: ${message}`, [], "error");
        },
      )),
    };
  }
};

const reviveHandler: CommandHandler = async ({ deps, rawText, surface, conversation }) => {
  const args = parseReviveSubagentArgs(rawText);
  if (args === null) return replied(REVIVE_SUBAGENT_USAGE_REPLY, [], "info");
  if (conversation === null) {
    return replied("No active conversation to revive from.", [], "error");
  }

  const attachment = await deps.dispatcher.admitReviveSubagent(
    surface,
    conversation,
    args.id,
    args.prompt,
  );
  const completion = attachment.completion.then(
    (result) => replied(
      result === "" ? `Revived subagent \`${args.id}\`.` : `Revived subagent \`${args.id}\`:\n${result}`,
      [],
      "ok",
    ),
    (err: unknown) => {
      log.error("revive failed", { id: args.id, ...boundedError(err) });
      return replied(`Failed to revive subagent \`${args.id}\`.`, [], "error");
    },
  );
  switch (attachment.kind) {
    case "handoff": return { kind: "admission", admission: runtimeAdmission.handoff(completion) };
    case "busy": return { kind: "admission", admission: runtimeAdmission.busy(completion) };
    case "fenced": return { kind: "admission", admission: runtimeAdmission.fenced(completion) };
    case "rejected": return { kind: "admission", admission: runtimeAdmission.rejected(completion) };
  }
};

const helpHandler: CommandHandler = async () => replied(helpReply(), [], "info");

const voiceHandler: CommandHandler = async ({ deps, conversation, surface, bot }) => {
  if (!conversation) return replied("No active conversation. Use /new to start one.", [], "info");
  if (!bot) {
    log.error("voice dispatch bot missing");
    return replied("Voice generation failed: internal error", [], "error");
  }
  const completion = executeVoice({
      home: deps.cfg.goblinHome,
      sessionId: conversation.id,
      bot,
      surface,
    }).then(
      (voiceResult): CommandCompletionResult => {
        switch (voiceResult.kind) {
          case "no-messages":
            return replied("No messages to voice yet.", [], "info");
          case "tts-failed":
            log.warn("voice failed", { error: voiceResult.error, sessionId: conversation.id });
            return replied(`Voice generation failed: ${voiceResult.error}`, [], "error");
          case "sent":
            return { kind: "handled", sideEffects: [] };
        }
      },
      (err: unknown) => {
        log.error("voice failed", { error: String(err), sessionId: conversation.id });
        return replied(`Voice generation failed: ${errorMessage(err)}`, [], "error");
      },
    );
  return { kind: "admission", admission: completed(completion) };
};

const queueHandler: CommandHandler = async ({ conversation, existingRunner, rawText, surface }) => {
  if (!conversation) return replied("No active conversation.", [], "info");
  const arg = parseCommandArg(rawText);
  if (arg.length === 0) return replied("Usage: /queue <text>", [], "info");
  const sideEffects: SideEffect[] = [{ kind: "queue-prompt", conversation, surface, text: arg }];
  const ack = existingRunner?.isStreaming ? "Queued. Will run after the current turn." : "Running.";
  const tag: SystemTag = existingRunner?.isStreaming ? "queued" : "ok";
  return replied(ack, sideEffects, tag);
};

const skillsHandler: CommandHandler = async ({ deps, surface, rawText }) => {
  try {
    const intent = parseSkillsCommand(rawText);
    if (intent.kind === "inspect") {
      const status = await deps.lifecycle.inspectSkillPolicy(surface);
      return replied(formatSkillsStatus(status), [], "info");
    }
    if (intent.kind === "reload") {
      const result = await deps.lifecycle.reloadSkills(surface);
      return replied(formatSkillsTransition(intent, result), [], result.cleanupError ? "warn" : "ok");
    }
    const result = await deps.lifecycle.setSkillSelection(surface, intent.source, intent.selection);
    return replied(formatSkillsTransition(intent, result), [], result.cleanupError ? "warn" : "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("skills command failed", { error: message, surfaceId: surfaceId(surface) });
    return replied(`Skills command rejected: ${message}`, [], "warn");
  }
};

const scheduleHandler: CommandHandler = async ({ deps, surface, rawText }) => {
  // `/schedule` is instant-timing and surface-owned: it mutates the schedule
  // store for the invoking Surface and does not require a bound conversation.
  if (!deps.scheduleStore) {
    return replied("Scheduling is not available.", [], "warn");
  }
  const depsForSchedule = buildScheduleDeps(deps.scheduleStore, surface, Date.now());
  const result = executeSchedule(depsForSchedule, rawText);
  return replied(result.reply, [], result.tag);
};

// ---------------------------------------------------------------------------
// grammy handler factories
// ---------------------------------------------------------------------------

const pingGrammyFactory: GrammyHandlerFactory = () => pingHandler;
const startGrammyFactory: GrammyHandlerFactory = ({ lifecycle }) => {
  if (!lifecycle) {
    throw new Error("startGrammyFactory requires a ConversationLifecycle");
  }
  return buildStartHandler(lifecycle);
};

/**
 * Timing predicate for argument-conditional commands: instant with no
 * argument (list/show), queue with an argument (mutate). Used by `/model`
 * and `/think`.
 */
function instantUnlessArg(rawText: string): CommandTiming {
  return parseCommandArg(rawText) === "" ? "instant" : "queue";
}

function skillsTiming(rawText: string): CommandTiming {
  try {
    return parseSkillsCommand(rawText).kind === "inspect" ? "instant" : "queue";
  } catch {
    // Invalid syntax has no side effects and should be reported immediately.
    return "instant";
  }
}

// ---------------------------------------------------------------------------
// COMMAND_REGISTRY — the single source of truth
// ---------------------------------------------------------------------------

export const COMMAND_REGISTRY: readonly CommandDef[] = [
  {
    name: "cancel",
    description: "abort the current turn (cascades to subagents)",
    timing: "interrupt",
    handler: cancelHandler,
  },
  {
    name: "new",
    description: "reset this chat: rotate to a fresh conversation and leave the prior one resumable",
    timing: "queue",
    mayRecoverWedgedRuntime: true,
    handler: newHandler,
  },
  {
    name: "archive",
    description: "archive the active conversation",
    timing: "queue",
    mayRecoverWedgedRuntime: true,
    handler: archiveHandler,
  },
  {
    name: "project",
    argsHint: "<dir>",
    description: "assign this chat to a canonical project directory (one-time, immutable)",
    timing: "queue",
    handler: projectHandler,
  },
  {
    name: "model",
    argsHint: "[index]",
    description: "list favorite models or switch to one",
    timing: instantUnlessArg,
    handler: modelHandler,
  },
  {
    name: "compact",
    argsHint: "[instructions]",
    description: "manually compact this conversation's context",
    timing: "queue",
    handler: compactHandler,
  },
  {
    name: "debug",
    description: "dump conversation diagnostics",
    timing: "instant",
    handler: debugHandler,
  },
  {
    name: "think",
    argsHint: "[level]",
    description: "show or set thinking level",
    timing: instantUnlessArg,
    handler: thinkHandler,
  },
  {
    name: "name",
    argsHint: "<name>",
    description: "name the active conversation",
    timing: "instant",
    handler: nameHandler,
  },
  {
    name: "resume",
    argsHint: "<id-or-name>",
    description: "bind this chat to an existing conversation",
    timing: "queue",
    handler: resumeHandler,
  },
  {
    name: "subagents",
    description: "list tracked subagents",
    timing: "instant",
    handler: subagentsHandler,
  },
  {
    name: "cancel_subagent",
    argsHint: "<id>",
    description: "cancel a single subagent",
    timing: "instant",
    handler: cancelSubagentHandler,
  },
  {
    name: "revive",
    argsHint: "<id> <prompt>",
    description: "revive a persisted subagent with a follow-up prompt",
    timing: "instant",
    handler: reviveHandler,
  },
  {
    name: "help",
    description: "show this list",
    timing: "instant",
    handler: helpHandler,
  },
  {
    name: "voice",
    aliases: ["v"],
    description: "convert the last assistant message to a voice note",
    timing: "instant",
    handler: voiceHandler,
  },
  {
    name: "queue",
    argsHint: "<text>",
    description: "enqueue text to run as a fresh turn after the current one settles",
    timing: "instant",
    handler: queueHandler,
  },
  {
    name: "schedule",
    argsHint: "<list|at|in|every|remove|pause|resume|heartbeat ...>",
    description: "manage scheduled turns and heartbeat for this surface",
    timing: "instant",
    handler: scheduleHandler,
  },
  {
    name: "skills",
    argsHint: "[reload|<source> all|none|only <name> ...]",
    description: "inspect or select Surface skill catalogs",
    timing: skillsTiming,
    mayRecoverWedgedRuntime: true,
    handler: skillsHandler,
  },
  {
    name: "ping",
    description: "smoke-test: reply with pong and chat info",
    timing: "instant",
    grammyHandler: pingGrammyFactory,
  },
  {
    name: "start",
    description: "welcome and status (DMs and forum topics)",
    timing: "instant",
    grammyHandler: startGrammyFactory,
  },
];

// ---------------------------------------------------------------------------
// Derived lookups — rebuilt once at module load
// ---------------------------------------------------------------------------

function buildLookup(): Map<string, CommandDef> {
  const lookup = new Map<string, CommandDef>();
  for (const def of COMMAND_REGISTRY) {
    lookup.set(def.name, def);
    for (const alias of def.aliases ?? []) {
      lookup.set(alias, def);
    }
  }
  return lookup;
}

const LOOKUP: ReadonlyMap<string, CommandDef> = buildLookup();

/**
 * Resolve a command token (with or without leading slash) to its CommandDef.
 * Returns null for unknown commands.
 */
export function resolveCommand(token: string): CommandDef | null {
  if (!token) return null;
  const key = token.startsWith("/") ? token.slice(1) : token;
  return LOOKUP.get(key) ?? null;
}

/**
 * Resolve the timing of a command for a given rawText. Function-form timing
 * (e.g. `/model` is instant with no arg, queue with an arg) is evaluated; a
 * null def defaults to `"instant"`.
 */
export function resolveTiming(def: CommandDef | null, rawText: string): CommandTiming {
  if (!def) return "instant";
  if (typeof def.timing === "function") return def.timing(rawText);
  return def.timing ?? "instant";
}

/**
 * Build the /help reply text from the registry. One line per def:
 *   /<name><args> — <description>
 * where <args> is a leading space plus argsHint if present, otherwise empty.
 */
export function helpReply(): string {
  const lines = ["Commands:"];
  for (const def of COMMAND_REGISTRY) {
    const args = def.argsHint ? ` ${def.argsHint}` : "";
    lines.push(`/${def.name}${args} — ${def.description}`);
  }
  return lines.join("\n");
}

/**
 * Telegram BotCommand name sanitization: lowercase, hyphens → underscores,
 * truncated to 32 chars, must match ^[a-z][a-z0-9_]{0,31}$.
 */
function sanitizeTelegramName(name: string): string | null {
  const sanitized = name.toLowerCase().replace(/-/g, "_").slice(0, 32);
  return /^[a-z][a-z0-9_]{0,31}$/.test(sanitized) ? sanitized : null;
}

/**
 * Derive the BotCommand[] payload for setMyCommands from the registry.
 * Aliases are excluded — one menu entry per canonical command.
 * Descriptions are truncated to 256 chars (Telegram's limit).
 */
export function telegramBotCommands(): { command: string; description: string }[] {
  const result: { command: string; description: string }[] = [];
  for (const def of COMMAND_REGISTRY) {
    const command = sanitizeTelegramName(def.name);
    if (!command) {
      log.warn("command name fails Telegram sanitization; excluded from menu", { name: def.name });
      continue;
    }
    const description = def.description.slice(0, 256);
    result.push({ command, description });
  }
  return result;
}

/**
 * Populate Telegram's `/` autocomplete menu from the registry.
 *
 * Best-effort: on failure, calls `warn` with the error and resolves — the
 * bot continues starting. Commands still dispatch via the `message:text`
 * handler regardless of whether the menu is populated.
 */
export async function syncTelegramMenu(
  api: { setMyCommands: (commands: { command: string; description: string }[]) => Promise<unknown> },
  warn: (message: string, context?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await api.setMyCommands(telegramBotCommands());
  } catch (err) {
    warn("setMyCommands failed; / autocomplete menu may be stale", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
