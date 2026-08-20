import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { boundedError, log } from "../log.ts";
import { AgentRunner, type TurnCallbacks } from "../agent/mod.ts";
import {
  MemoryStore,
  EmbeddingProvider,
  DreamingPipeline,
  type InternalMemoryContext,
} from "../memory/mod.ts";
import type { ConversationState } from "../sessions/types.ts";
import { assertInternalSessionState, type InternalSessionState } from "../sessions/internal-session.ts";
import { surfaceId, type Surface } from "../surface.ts";
import {
  SubagentCancellationRejectedError,
  SubagentReviveBusyError,
  SubagentReviveRejectedError,
  SubagentRunner,
} from "../subagents/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import type { DelegatedRuntimeContext } from "../delegated-work/mod.ts";
import { runtimeAdmission, type RuntimeAdmissionResult } from "../shutdown/mod.ts";
import { BindingFencedError, type SurfaceSettings } from "./conversation-lifecycle.ts";
import { PreparedRuntimeAssembler } from "./prepared-runtime.ts";
import type { PreparedSurfaceRuntimePlan } from "../agent/runtime-plan.ts";
import { CapabilityManifestToolSource } from "../agent/tool-assembly.ts";
import {
  ConversationRuntimeHost,
  type ImmediateWorkAdmission,
  type ImmediateWorkExecutionResult,
  type ImmediateWorkSettlement,
  type RuntimeDisposalOptions,
  type SteerOrQueueResult,
  type WorkAuthority,
  type WorkIntent,
} from "./conversation-runtime-host.ts";
import type { AttachedWork, SurfaceRuntimeAuthority } from "./surface-runtime-authority.ts";
export type { AttachmentSignal, AttachedWork, CurrentBindingGuard, SurfaceRuntimeAuthority } from "./surface-runtime-authority.ts";
export type { SurfaceSettings };

type CurrentRuntimeWorkIntent = Extract<WorkIntent, { kind: "current-runtime" }>;

export class RuntimeAdmissionFailedBeforeDecisionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RuntimeAdmissionFailedBeforeDecisionError";
    this.cause = cause;
  }
}

export interface ScheduledTurnAdmission {
  readonly accepted: true;
  /** Resolves false when shutdown fences the queued entry before it starts. */
  readonly started: Promise<boolean>;
}

export interface ImmediateTurnDelivery {
  readonly success: () => Promise<void>;
  readonly failure: (error: unknown) => Promise<void>;
}

export type ImmediateTurnSettlement = ImmediateWorkSettlement & {
  /** Delivery starts at the final authority commit but is not runtime-owned. */
  readonly delivery?: Promise<void>;
};

export type ImmediateTurnAdmission =
  | { readonly kind: "accepted"; readonly settlement: Promise<ImmediateTurnSettlement> }
  | Exclude<ImmediateWorkAdmission, { kind: "accepted" }>;

/** Prompt content accepted by a runner: a string or multimodal parts. */
export type PromptContent = string | (TextContent | ImageContent)[];

/**
 * The opaque sink a turn dispatches through — the subset of `MessageBuffer`
 * that `runner.prompt(content, sink)` consumes. Typed as `TurnCallbacks` so the
 * dispatcher does not depend on the concrete `MessageBuffer` type or on
 * `src/tg/`. The Telegram layer injects a factory that produces real
 * `MessageBuffer` instances; the dispatcher is transport-agnostic at the type
 * level.
 */
export type TurnSink = TurnCallbacks;

function buildGetTopicName(store: MemoryStore): (chatId: number, topicId: number) => Promise<string | null> {
  return async (chatId, topicId) => {
    const { description } = store.read({ topic: { chatId, topicId } });
    return description ?? null;
  };
}

export interface TurnDispatcherOptions {
  cfg: Config;
  surfaceSettings: SurfaceSettings;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  /** The single owner of runtime state, supplied by the composition root. */
  runtimeHost: ConversationRuntimeHost;
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  /**
   * Shared embedding provider for agent memory stores. When present, each
   * runner gets its own SQLite connection using this provider.
   */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Shared dreaming pipeline for background memory promotion. When present,
   * all chat runners use the same pipeline instance so cursor state and the
   * model-driven extractor are consistent across per-turn and scheduled passes.
   */
  dreamingPipeline?: DreamingPipeline;
  /**
   * Mandatory factory that builds the turn sink for a surface. The dispatcher
   * never constructs a `MessageBuffer` itself — the Telegram-aware caller
   * (intake) injects this so rendering knowledge stays in `src/tg/`.
   */
  createMessageBuffer: (surface: Surface, conversation?: ConversationState) => TurnSink;
  /**
   * Mandatory factory that builds Telegram-specific beta tools (voice, photo,
   * document, TTS) for a surface. The dispatcher does not import from `src/tg/`;
   * the Telegram-aware caller (intake) injects this so beta tool creation stays
   * in the Telegram layer.
   */
  createBetaTools: (surface: Surface) => ToolDefinition[];
  /** Shared schedule store. When present, the `schedule_turn` tool is wired to the main agent. */
  scheduleStore?: ScheduleStore;
  /**
   * Shared external agent runner. When present, it is wired into every new
   * `AgentRunner` and cancelled during `disposeRunner`.
   */
  externalAgentRunner?: ExternalAgentRunner;
  /** Shared MCP runner. When present and configured, it is wired into every new `AgentRunner`. */
  mcpRunner?: McpRunner;
  /**
   * Mandatory lifecycle-owned authority for Surface-backed runtime acquisition,
   * stale-runner checks, and attached subagent revival. Internal runtimes use
   * the explicit `enqueueInternalTurn` path and do not consume this seam.
   */
  surfaceRuntimeAuthority: SurfaceRuntimeAuthority;
}

/**
 * Shared turn dispatcher: owns `AgentRunner` construction and turn execution;
 * `ConversationRuntimeHost` owns runtime registration, per-Conversation queues,
 * and disposal. Both Telegram intake and the scheduled-turn scheduler dispatch
 * through this kernel so a due scheduled prompt and a Telegram message share
 * the same serialization boundary.
 *
 * The stale-runner guard (`isCurrent()`) is the linchpin: when a runner is
 * swapped (by `/new` or `/resume`) before a queued turn starts, the queued work
 * detects it is no longer current and aborts before producing user-visible side
 * effects.
 *
 * Lives in `src/orchestration/` — turn serialization is an orchestration
 * concern, not a Telegram concern. The dispatcher does not import the
 * `MessageBuffer` type; it obtains its turn sink through the injected
 * `createMessageBuffer` factory.
 */
export class TurnDispatcher {
  /** Concrete owner of runner registration, in-flight creation, and queues. */
  private readonly runtimeHost: ConversationRuntimeHost;
  private readonly cfg: Config;
  private readonly surfaceSettings: SurfaceSettings;
  private readonly subagentRunner: SubagentRunner;
  private readonly memoryStore: MemoryStore;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly dreamingPipeline?: DreamingPipeline;
  private readonly createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  private readonly createMessageBufferFn: (surface: Surface, conversation?: ConversationState) => TurnSink;
  private readonly createBetaToolsFn: (surface: Surface) => ToolDefinition[];
  private readonly getTopicName: (chatId: number, topicId: number) => Promise<string | null>;
  private readonly scheduleStore: ScheduleStore | undefined;
  private readonly externalAgentRunner: ExternalAgentRunner | undefined;
  private readonly mcpRunner: McpRunner | undefined;
  private readonly surfaceRuntimeAuthority: SurfaceRuntimeAuthority;
  private readonly runtimeAssembler: PreparedRuntimeAssembler;

  constructor(options: TurnDispatcherOptions) {
    this.cfg = options.cfg;
    this.surfaceSettings = options.surfaceSettings;
    this.subagentRunner = options.subagentRunner;
    this.memoryStore = options.memoryStore;
    this.embeddingProvider = options.embeddingProvider;
    this.dreamingPipeline = options.dreamingPipeline;
    this.createAgentRunner = options.createAgentRunner;
    this.createMessageBufferFn = options.createMessageBuffer;
    this.createBetaToolsFn = options.createBetaTools;
    this.getTopicName = buildGetTopicName(this.memoryStore);
    this.scheduleStore = options.scheduleStore;
    this.externalAgentRunner = options.externalAgentRunner;
    this.mcpRunner = options.mcpRunner;
    this.runtimeHost = options.runtimeHost;
    this.surfaceRuntimeAuthority = options.surfaceRuntimeAuthority;
    this.runtimeAssembler = new PreparedRuntimeAssembler({
      cfg: this.cfg,
      surfaceRuntimeAuthority: this.surfaceRuntimeAuthority,
      runtimeHost: this.runtimeHost,
      memoryStore: this.memoryStore,
      getTopicName: this.getTopicName,
      createSurfaceTools: this.createBetaToolsFn,
      subagentRunner: this.subagentRunner,
      scheduleStore: this.scheduleStore,
      externalAgentRunner: this.externalAgentRunner,
      mcpRunner: this.mcpRunner,
    });
  }

  /**
   * Return the current runner for a session, or null if none exists. Replaces
   * direct reads of the (now-private) `runners` map.
   */
  getRunner(sessionId: string): AgentRunner | null {
    return this.runtimeHost.getRunner(sessionId);
  }

  /**
   * True when a runner is currently registered for a session. Replaces direct
   * `runners.has(...)` reads of the (now-private) map.
   */
  hasRunner(sessionId: string): boolean {
    return this.runtimeHost.hasRunner(sessionId);
  }

  /** True when a runner or an in-flight runtime construction owns this id. */
  hasRuntime(sessionId: string): boolean {
    return this.runtimeHost.hasRuntime(sessionId);
  }

  /** Construct an AgentRunner only from a completed immutable plan. */
  private createRunner(plan: PreparedSurfaceRuntimePlan): AgentRunner {
    this.runtimeHost.assertAdmissionOpen();
    let runner!: AgentRunner;
    const delegatedRuntimeContext: DelegatedRuntimeContext = {
      ownerConversationId: plan.conversationId,
      runtimeId: plan.runtimeId,
      originSurfaceId: plan.surfaceId,
      executionEnvironment: plan.executionEnvironment,
    };
    // The runner's isCurrent closure uses registration identity, not epoch
    // comparison. The runner IS the runtime generation; its authority is its
    // registration. Lifecycle invalidation synchronously clears the runner,
    // so isRegisteredRunner is the runner's commit-point authority. Epoch
    // tickets are for work units (prompts, commands, scheduled turns), not
    // for the runner itself (decision 0046).
    const runnerOpts: ConstructorParameters<typeof AgentRunner>[0] = {
      cfg: this.cfg,
      sessionId: plan.conversationId,
      plan,
      surfaceToolSource: new CapabilityManifestToolSource(plan, {
        scheduleStore: this.scheduleStore,
        subagentRunner: this.subagentRunner,
        externalAgentRunner: this.externalAgentRunner,
        mcpRunner: this.mcpRunner,
      }),
      getTopicName: this.getTopicName,
      delegatedRuntimeContext,
      embeddingProvider: this.embeddingProvider,
      dreamingPipeline: this.dreamingPipeline,
      isCurrent: () => this.runtimeHost.isRegisteredRunner(plan.conversationId, runner),
    };
    runner = this.createAgentRunner?.(runnerOpts) ?? new AgentRunner(runnerOpts);
    return runner;
  }

  /**
   * Revive a persisted subagent from the current runner's captured Surface
   * authority. Commands only parse/reply and call this method; they never join
   * runner, capture, and binding state themselves.
   *
   * The operation runs under the lifecycle-provided current-binding guard.
   * The guard verifies the requested Surface is still bound to the Conversation,
   * the registered runner is current for that Surface, and its captured
   * `sourceSurfaceId` matches. The revived invocation is attached before the
   * guard is released, so a concurrent lifecycle replacement waits for
   * attachment and then cancels the subagent through the normal disposal path
   * if it chooses.
   *
   * Throws before `AgentSession` creation when the runner is absent, stale,
   * or Surface-backed capture mismatch.
   *
   * The returned result rejects after completion when the runner was
   * invalidated while the revived subagent was running; stale output is
   * suppressed.
   */
  async beginReviveSubagent(
    surface: Surface,
    session: ConversationState,
    subagentId: string,
    prompt: string,
  ): Promise<AttachedWork<string>> {
    const expectedSurfaceId = surfaceId(surface);

    const attached = await this.surfaceRuntimeAuthority.withCurrentBinding(
      surface,
      session.id,
      async (signal) => {
        const runner = this.runtimeHost.getRunner(session.id);
        if (runner === null) {
          throw new SubagentReviveRejectedError(
            `no current runner for session ${session.id}; cannot revive subagent '${subagentId}'`,
          );
        }
        if (runner.memoryContext.kind !== "surface") {
          throw new Error(
            `runner memory context is not Surface-backed for session ${session.id}`,
          );
        }
        if (runner.memoryContext.authority.sourceSurfaceId !== expectedSurfaceId) {
          throw new Error(
            `runner capture sourceSurfaceId mismatch for session ${session.id}: ${runner.memoryContext.authority.sourceSurfaceId} !== ${expectedSurfaceId}`,
          );
        }

        // Capture the runtime epoch while the binding guard still excludes
        // lifecycle replacement. After the lock is released, a concurrent
        // invalidation can bump the epoch and a later capture would adopt
        // the replacement generation.
        const epoch = this.runtimeHost.captureEpoch(session.id, "runtime");

        const result = this.subagentRunner.revive(
          runner.memoryContext,
          runner.genericSubagentInheritance,
          subagentId,
          prompt,
          undefined,
          () => signal.attached(),
          runner.delegatedRuntimeContext ?? undefined,
        );

        // If revival fails before attachment, reject the attachment gate so the
        // lifecycle transition lock is released. After attachment, the terminal
        // result promise is returned to the caller.
        result.catch((err) => {
          if (!signal.settled) {
            signal.failed(err);
          }
        });

        return { result, runner, epoch };
      },
    );

    return {
      ...attached,
      result: this.completeRevivedSubagent(
        attached.result,
        attached.runner,
        attached.epoch,
        session.id,
        subagentId,
      ),
    };
  }

  /** Authoritatively classify delegated-run attachment for update settlement. */
  async admitReviveSubagent(
    surface: Surface,
    session: ConversationState,
    subagentId: string,
    prompt: string,
  ): Promise<RuntimeAdmissionResult<string>> {
    try {
      const attached = await this.beginReviveSubagent(surface, session, subagentId, prompt);
      return runtimeAdmission.handoff(attached.result);
    } catch (error) {
      if (error instanceof SubagentReviveBusyError) {
        return runtimeAdmission.busy(Promise.reject(error));
      }
      if (error instanceof SubagentReviveRejectedError) {
        return runtimeAdmission.rejected(Promise.reject(error));
      }
      if (error instanceof BindingFencedError) {
        return runtimeAdmission.fenced(Promise.reject(error));
      }
      throw new RuntimeAdmissionFailedBeforeDecisionError(error);
    }
  }

  /** Compatibility wrapper for non-admission callers that want the result. */
  async reviveSubagent(
    surface: Surface,
    session: ConversationState,
    subagentId: string,
    prompt: string,
  ): Promise<string> {
    const attached = await this.beginReviveSubagent(surface, session, subagentId, prompt);
    return await attached.result;
  }

  private async completeRevivedSubagent(
    resultPromise: Promise<string>,
    runner: AgentRunner | undefined,
    epoch: number | undefined,
    sessionId: string,
    subagentId: string,
  ): Promise<string> {
    // Authority was captured under the binding guard. Lifecycle invalidation
    // bumps the epoch synchronously, so a revived subagent that completes
    // after its runtime was invalidated sees a stale ticket here. The saved
    // runner must also still be the registered generation — a replacement
    // that happens to share the captured epoch must not accept this result.
    const result = await resultPromise;
    if (
      runner === undefined ||
      epoch === undefined ||
      !this.runtimeHost.isEpochCurrent(sessionId, "runtime", epoch) ||
      !this.runtimeHost.isRegisteredRunner(sessionId, runner)
    ) {
      log.warn("revived subagent completed after its runtime was invalidated", {
        subagentId,
        sessionId,
      });
      throw new Error(`subagent '${subagentId}' completed after its runtime was invalidated`);
    }
    // A blocking command is the delivery boundary for a revived run. The host
    // keeps a completed attached registration pending until this acknowledgement
    // so runtime invalidation can still suppress a stale result.
    if (typeof this.subagentRunner.acknowledgeDelivery === "function") {
      this.subagentRunner.acknowledgeDelivery(subagentId);
    }
    return result;
  }

  /** Return the current runtime, or prepare and atomically commit one generation. */
  async getOrCreateRunner(session: ConversationState, surface: Surface): Promise<AgentRunner> {
    const admission = this.admitGetOrCreateRunner(session, surface);
    if (admission.kind === "rejected") {
      throw new Error("runtime admission rejected: admission is closed");
    }
    return await admission.completion;
  }

  /**
   * Authoritatively classify runner acquisition for an update boundary.
   * A creation reservation or attachment to an existing generation commits
   * synchronously; preparation and binding checks remain completion work.
   */
  admitGetOrCreateRunner(
    session: ConversationState,
    surface: Surface,
  ): RuntimeAdmissionResult<AgentRunner> {
    // Runtime closure is the owner's generic rejected result, not a
    // failed-before-decision exception (decision 0046). Check openness
    // synchronously and map to runtimeAdmission.rejected(). The completion
    // settles immediately: callers branch on rejection before consuming the
    // value, and the gate does not await a rejected completion, so a
    // never-resolving promise would hang the shutdown drain without anyone
    // ever reading its value.
    if (!this.runtimeHost.isAdmissionOpen()) {
      return runtimeAdmission.rejected(undefined as unknown as AgentRunner);
    }
    try {
      if (this.runtimeHost.isInternalRuntime(session.id)) {
        throw new Error(`conversation ${session.id} is reserved by an internal runtime`);
      }

      const expectedSurfaceId = surfaceId(surface);
      const snapshot = this.surfaceSettings.getRuntimeSettings(surface);
      const existing = this.runtimeHost.getRunner(session.id);
      const existingSurfaceId = this.runtimeHost.surfaceIdFor(session.id);
      const existingSkillContext = this.runtimeHost.skillContextFor(session.id);
      if (
        existing &&
        existingSurfaceId === expectedSurfaceId &&
        existingSkillContext?.settingsFingerprint === snapshot.fingerprint
      ) {
        const completion = (async (): Promise<AgentRunner> => {
          await this.surfaceRuntimeAuthority.assertCurrentBinding(surface, session.id);
          if (
            this.runtimeHost.isRegisteredRunner(session.id, existing) &&
            this.runtimeHost.surfaceIdFor(session.id) === expectedSurfaceId &&
            this.runtimeHost.skillContextFor(session.id)?.settingsFingerprint === snapshot.fingerprint
          ) return existing;
          return await this.getOrCreateRunner(session, surface);
        })();
        return runtimeAdmission.handoff(completion);
      }

      const inFlight = this.runtimeHost.creationFor(session.id);
      if (
        inFlight &&
        inFlight.surfaceId === expectedSurfaceId &&
        inFlight.settingsFingerprint === snapshot.fingerprint
      ) return runtimeAdmission.handoff(inFlight.promise);

      const creation = this.runtimeHost.reserveCreation(
        session.id,
        expectedSurfaceId,
        snapshot.fingerprint,
      );
      const creationPromise = creation.promise;
      this.doCreateAndRegisterRunner(session, surface, snapshot, creation)
        .then(creation.resolve, creation.reject)
        .finally(() => this.runtimeHost.finishCreation(session.id, creationPromise, creation));
      return runtimeAdmission.handoff(creationPromise);
    } catch (error) {
      throw new RuntimeAdmissionFailedBeforeDecisionError(error);
    }
  }

  private async doCreateAndRegisterRunner(
    session: ConversationState,
    surface: Surface,
    snapshot: ReturnType<SurfaceSettings["getRuntimeSettings"]>,
    creation: ReturnType<ConversationRuntimeHost["reserveCreation"]>,
  ): Promise<AgentRunner> {
    let plan: PreparedSurfaceRuntimePlan;
    try {
      plan = await this.runtimeAssembler.prepare(session, surface, creation, snapshot);
    } catch (error) {
      log.error("runtime preparation failed", {
        conversationId: session.id,
        surfaceId: surfaceId(surface),
        ...boundedError(error),
      });
      throw error;
    }

    // No await is permitted between this final candidate check, construction,
    // and registration. Lifecycle invalidation synchronously removes the
    // reservation, so a stale plan cannot resurrect afterward. Every
    // settings-mutation path bumps the runtime epoch through lifecycle
    // invalidation, which drops the in-flight creation — the
    // isCurrentCreation check is sufficient without a settings re-read.
    if (!this.runtimeHost.isCurrentCreation(session.id, creation.promise)) {
      throw new Error(`stale runtime creation for conversation ${session.id}: invalidated before registration`);
    }
    const runner = this.createRunner(plan);
    this.runtimeHost.registerSurfaceRuntime(session.id, runner, {
      surfaceId: plan.surfaceId,
      runtimeId: plan.runtimeId,
      skillContext: {
        settingsFingerprint: plan.settingsFingerprint,
        policyFingerprint: plan.policyFingerprint,
        manifestFingerprint: plan.resolvedSkills.fingerprint,
      },
    });
    log.debug("created prepared runner for conversation", {
      conversationId: session.id,
      surfaceId: plan.surfaceId,
      runtimeId: plan.runtimeId,
      modelName: plan.modelName,
      manifestFingerprint: plan.resolvedSkills.fingerprint,
      capabilities: plan.capabilityManifest.capabilities,
    });
    return runner;
  }

  /**
   * Build the turn sink for a surface via the injected factory. Always
   * delegates to `createMessageBufferFn` — there is no fallback, the factory
   * is mandatory at construction.
   */
  createMessageBuffer(surface: Surface, conversation?: ConversationState): TurnSink {
    return this.createMessageBufferFn(surface, conversation);
  }

  /**
   * Admit a no-wait turn through one machine-owned occupancy and authority
   * boundary. Delivery callbacks are transport-neutral and run only after a
   * final current-authority check.
   */
  admitImmediateTurn(
    conversation: ConversationState,
    surface: Surface,
    content: PromptContent,
    sink: TurnSink,
    delivery: ImmediateTurnDelivery,
  ): ImmediateTurnAdmission {
    let deliveryPromise: Promise<void> | undefined;
    const startDelivery = (start: () => Promise<void>): void => {
      try {
        deliveryPromise = start();
      } catch (error) {
        deliveryPromise = Promise.reject(error);
      }
      // Runtime settlement must not await transport I/O, but the promise stays
      // observed until the admitted handler awaits it after releasing runtime
      // admission.
      void deliveryPromise.catch(() => {});
    };

    const admission = this.runtimeHost.admitImmediateRuntimeWork(
      conversation.id,
      async ({ authority, runnerAtAdmission }): Promise<ImmediateWorkExecutionResult> => {
        let runner = runnerAtAdmission;
        if (runner === null) {
          try {
            runner = await this.getOrCreateRunner(conversation, surface);
          } catch (error) {
            if (!authority.isCurrent()) return { kind: "fenced" };
            startDelivery(() => delivery.failure(error));
            return { kind: "completed" };
          }
          if (!authority.adoptCurrentRunner(runner)) return { kind: "fenced" };
        }

        if (!authority.isCurrent()) return { kind: "fenced" };
        try {
          await runner.prompt(content, sink);
        } catch (error) {
          if (!authority.isCurrent()) return { kind: "fenced" };
          startDelivery(() => delivery.failure(error));
          return { kind: "completed" };
        }

        if (!authority.isCurrent()) return { kind: "fenced" };
        startDelivery(delivery.success);
        return { kind: "completed" };
      },
    );
    if (admission.kind !== "accepted") return admission;
    return {
      kind: "accepted",
      settlement: admission.settlement.then((settlement) => ({
        ...settlement,
        ...(deliveryPromise === undefined ? {} : { delivery: deliveryPromise }),
      })),
    };
  }

  /**
   * Install cold ordinary work before asynchronous runtime preparation. The
   * bootstrap ticket owns the queue position and must adopt the runner before
   * caller effects or prompting.
   */
  scheduleBootstrapTurn(
    conversation: ConversationState,
    surface: Surface,
    run: (runner: AgentRunner, authority: WorkAuthority) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
    opts: { isPrompt?: boolean } = {},
  ): boolean {
    return this.runtimeHost.schedule(
      conversation.id,
      { kind: "bootstrap" },
      async (authority) => {
        const runner = await this.getOrCreateRunner(conversation, surface);
        if (!authority.adoptCurrentRunner(runner)) return;
        if (!authority.isCurrent()) return;
        await run(runner, authority);
      },
      onError,
      opts,
    );
  }

  /**
   * Acquire/adopt the runner and enqueue prompt work in one synchronous
   * admission section, returning a structural `RuntimeAdmissionResult`
   * immediately. For an already-registered runner, the queue entry is
   * admitted with `current-runtime` intent (runner known at admission
   * time). When no runner is registered yet, a `bootstrap` ticket owns
   * the queue position and acquires the runner inside the queued work,
   * so a stalled creation is cancelled by shutdown disposal rather than
   * deadlocking the runtime-admission drain (decision 0046).
   *
   * Preparation and prompt execution remain in the separately tracked
   * completion; only the structural decision is returned here.
   */
  admitPromptTurn(
    conversation: ConversationState,
    surface: Surface,
    run: (runner: AgentRunner, authority: WorkAuthority) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
    opts: { isPrompt?: boolean } = {},
  ): RuntimeAdmissionResult<void> {
    const existing = this.runtimeHost.getRunner(conversation.id);
    if (existing !== null) {
      const admitted = this.schedulePrompt(
        conversation,
        { kind: "current-runtime", runner: existing },
        (authority) => run(existing, authority),
        onError,
        opts,
      );
      if (!admitted) return runtimeAdmission.rejected(undefined);
      return runtimeAdmission.handoff(undefined);
    }
    const admitted = this.scheduleBootstrapTurn(
      conversation,
      surface,
      run,
      onError,
      opts,
    );
    if (!admitted) return runtimeAdmission.rejected(undefined);
    return runtimeAdmission.handoff(undefined);
  }

  /** Enqueue work tied to the runner that is current at admission. */
  schedulePrompt(
    conversation: ConversationState,
    intent: CurrentRuntimeWorkIntent,
    run: (authority: WorkAuthority) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    opts: { isPrompt?: boolean } = {},
  ): boolean {
    return this.runtimeHost.schedule(
      conversation.id,
      intent,
      run,
      onError,
      opts,
    );
  }

  /**
   * Attach a follow-up or admit its late-steer fallback in one synchronous
   * runtime-machine section. Telegram admission must not be released until
   * this returns — a rejected fallback is already final.
   */
  steerOrQueue(
    conversation: ConversationState,
    intent: CurrentRuntimeWorkIntent,
    attach: () => Promise<void>,
    run: (authority: WorkAuthority) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
  ): SteerOrQueueResult {
    return this.runtimeHost.steerOrQueue(conversation.id, attach, {
      intent,
      run,
      onError,
    });
  }

  /**
   * Serialize a lifecycle command behind current work without making the
   * disposed runner its authority. Same-binding runtime invalidation (for
   * example `/model`) preserves these commands; a binding change still makes
   * them stale before they can mutate state.
   */
  scheduleCommand(
    conversation: ConversationState,
    _surface: Surface,
    run: (authority: WorkAuthority) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    onSettled?: () => void,
  ): boolean {
    return this.runtimeHost.schedule(
      conversation.id,
      { kind: "binding" },
      run,
      onError,
      { isPrompt: false, onSettled },
    );
  }

  /**
   * True when the session has a deferred command that has been scheduled but
   * not yet settled. State-mutating commands that queue should also queue when
   * a command is already pending, so they serialize after it.
   */
  isCommandPending(sessionId: string): boolean {
    return this.runtimeHost.isCommandPending(sessionId);
  }

  /**
   * True when the session has a prompt turn that has been scheduled but not
   * yet started. This covers a coalescer-flushed prompt whose `handleText`
   * promise has scheduled but not yet started. Complements `runner.isStreaming`
   * and `runner.isPrompting`, which are false until `AgentRunner.prompt` is
   * actually called.
   */
  isPromptPending(sessionId: string): boolean {
    return this.runtimeHost.isPromptPending(sessionId);
  }

  /** True while any prompt queue entry is active or waiting to start. */
  hasPromptWork(sessionId: string): boolean {
    return this.runtimeHost.hasPromptWork(sessionId);
  }

  /**
   * Cancel the queued-but-not-yet-started prompt for a session, if one exists.
   * This is the complement to `isPromptPending`: it reaches a turn that has
   * been scheduled through `schedulePrompt` but has not yet started streaming,
   * so `runner.isStreaming` is still false and `interruptAndCascade` would not
   * abort it. `RuntimeMachine` removes and settles the queued entry without
   * touching `AgentRunner` or cascading to subagents. Returns true when a
   * pending prompt was found and canceled. The session remains alive and its
   * subagents may continue doing useful work.
   */
  cancelPending(sessionId: string): boolean {
    return this.runtimeHost.cancelPending(sessionId);
  }

  /**
   * Atomically classify and start runtime or delegated work for a conversation.
   * The structural decision (handoff/rejected) is owned by the runtime host;
   * callers pass a closed work intent and attach reply delivery to the
   * resulting completion. This is the classification boundary for operations
   * that perform runtime or delegated work but do not acquire a runner through
   * the normal prompt path (e.g. /cancel interrupts, /cancel_subagent
   * delegated cancellations). Commands map the result kind and attach reply
   * delivery; they do not invent admission classifications (decision 0046).
   *
   * The work callback is invoked synchronously inside this method when
   * admission is open, so the structural decision and the start of work are
   * one atomic step. A rejected admission does not invoke the callback — no
   * cancellation or runner work may start from a closed gate. The rejected
   * completion settles immediately so the gate drain cannot hang.
   */
  admitConversationControl<T>(
    surface: Surface,
    conversation: ConversationState,
    work: (authority: WorkAuthority) => Promise<T>,
  ): RuntimeAdmissionResult<T> {
    if (!this.surfaceRuntimeAuthority.isCurrentBinding(surface, conversation.id)) {
      return runtimeAdmission.fenced(undefined as unknown as T);
    }
    try {
      const admission = this.runtimeHost.admitBindingControlWork(conversation.id, work);
      switch (admission.kind) {
        case "accepted": return runtimeAdmission.handoff(admission.completion);
        case "closed": return runtimeAdmission.rejected(undefined as unknown as T);
        case "fenced": return runtimeAdmission.fenced(undefined as unknown as T);
      }
    } catch (error) {
      throw new RuntimeAdmissionFailedBeforeDecisionError(error);
    }
  }

  /** Delegated-work-owned cancellation classification and synchronous claim. */
  admitCancelSubagent(
    surface: Surface,
    conversation: ConversationState,
    id: string,
  ): RuntimeAdmissionResult<void> {
    if (!this.surfaceRuntimeAuthority.isCurrentBinding(surface, conversation.id)) {
      return runtimeAdmission.fenced(undefined);
    }
    try {
      const admission = this.runtimeHost.admitBindingControlWork(
        conversation.id,
        (authority) => {
          if (!authority.isCurrent()) {
            throw new BindingFencedError(surfaceId(surface), conversation.id, null);
          }
          const completion = this.subagentRunner.beginCancel(id, conversation.id);
          const assertStillCurrent = (): void => {
            if (!authority.isCurrent()) {
              throw new BindingFencedError(surfaceId(surface), conversation.id, null);
            }
          };
          return completion.then(
            () => { assertStillCurrent(); },
            (error: unknown) => {
              assertStillCurrent();
              throw error;
            },
          );
        },
      );
      switch (admission.kind) {
        case "accepted": return runtimeAdmission.handoff(admission.completion);
        case "closed": return runtimeAdmission.rejected(undefined);
        case "fenced": return runtimeAdmission.fenced(undefined);
      }
    } catch (error) {
      if (error instanceof SubagentCancellationRejectedError) {
        return runtimeAdmission.rejected(Promise.reject(error));
      }
      if (error instanceof BindingFencedError) {
        return runtimeAdmission.fenced(Promise.reject(error));
      }
      throw new RuntimeAdmissionFailedBeforeDecisionError(error);
    }
  }

  /**
   * Dispose a session's runner and sever its prompt-queue chain so any queued
   * work for the stale runner aborts via the `isCurrent()` guard. Safe to call
   * when no runner exists (no-op).
   *
   * Delegates the complete runtime cleanup boundary to
   * `ConversationRuntimeHost`: it fences the registration and queue first,
   * then disposes the runner and awaits delegated/external cleanup.
   *
   * @param preserveInFlight When called from `doCreateAndRegisterRunner` to
   *   dispose an old runner before creating a replacement, pass the new
   *   creation's promise so the in-flight entry for it is preserved. Without
   *   this, the in-flight entry would be cleared and the new creation's
   *   post-capture recheck would discard it.
   */
  async disposeRunner(
    sessionId: string,
    preserveInFlight?: Promise<AgentRunner>,
    options?: RuntimeDisposalOptions,
  ): Promise<void> {
    return this.runtimeHost.disposeRuntime(sessionId, {
      ...options,
      preserveInFlight,
    });
  }

  /**
   * Invalidation is synchronous inside the runtime host; cleanup remains the
   * separately-lived completion of the resulting handoff decision.
   *
   * Calls `runtimeHost.disposeRuntime` directly rather than the `async
   * disposeRunner` wrapper so a synchronous host failure is caught by the
   * try/catch and classified as failed-before-decision, not misclassified as
   * handoff with a rejecting completion.
   */
  admitDisposeRunner(
    sessionId: string,
    preserveInFlight?: Promise<AgentRunner>,
    options?: RuntimeDisposalOptions,
  ): RuntimeAdmissionResult<void> {
    try {
      return runtimeAdmission.handoff(
        this.runtimeHost.disposeRuntime(sessionId, {
          ...options,
          preserveInFlight,
        }),
      );
    } catch (error) {
      throw new RuntimeAdmissionFailedBeforeDecisionError(error);
    }
  }

  /**
   * Enqueue an internal turn for a non-chat session. Used for background
   * work such as the dreaming pipeline. The runner has no beta tools and writes
   * assistant text into an in-memory capture buffer. `onComplete(text)` is
   * called after `runner.prompt` resolves with the captured assistant text.
   */
  enqueueInternalTurn(
    session: InternalSessionState,
    content: PromptContent,
    onComplete: (text: string) => void,
    onError: (err: unknown) => void,
  ): void {
    this.runtimeHost.assertAdmissionOpen();
    assertInternalSessionState(session);
    let runner = this.runtimeHost.getRunner(session.id);
    if (runner && !this.runtimeHost.isInternalRuntime(session.id)) {
      throw new Error(`cannot reuse Surface-backed runtime ${session.id} for an internal turn`);
    }
    if (!runner) {
      // Internal sessions (dreaming extraction) use the explicit Surface-free
      // internal memory context. They receive no memory tools, no frozen
      // summary, and no per-turn relevant-memory aside. The compatibility
      // dreaming session's chatId:0 is NOT reinterpreted as a Telegram
      // Surface.
      const internalContext: InternalMemoryContext = {
        kind: "internal",
        caller: { kind: "internal" },
      };
      const runnerOpts: ConstructorParameters<typeof AgentRunner>[0] = {
        cfg: this.cfg,
        sessionId: session.id,
        memoryContext: internalContext,
        customTools: [],
        memoryStore: this.memoryStore,
        embeddingProvider: this.embeddingProvider,
        dreamingPipeline: this.dreamingPipeline,
        getTopicName: this.getTopicName,
        executionEnvironment: session.executionEnvironment,
      };
      runner = this.createAgentRunner?.(runnerOpts) ?? new AgentRunner(runnerOpts);
      this.runtimeHost.registerInternalRuntime(session.id, runner);
    }

    const captured: string[] = [];
    let settled = false;
    const complete = (text: string): void => {
      if (settled) return;
      settled = true;
      onComplete(text);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      onError(error);
    };
    const sink: TurnCallbacks = {
      onTextDelta: (text) => captured.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onStatusUpdate: () => {},
      onMessageStart: () => {},
      onMessageEnd: () => {},
      onAgentEnd: () => {},
    };

    const admitted = this.runtimeHost.schedule(
      session.id,
      { kind: "internal-runtime", runner },
      async (authority) => {
        await runner.prompt(content, sink);
        if (authority.isCurrent()) complete(captured.join(""));
      },
      fail,
      {
        isPrompt: false,
        onFenced: () => fail(new Error(`internal runtime turn fenced for ${session.id}`)),
      },
    );
    if (!admitted) fail(new Error(`internal runtime turn rejected for ${session.id}`));
  }

  /**
   * True when the runtime kernel is still accepting new work. The scheduler
   * reads this before claiming a due occurrence so a shutdown in flight does
   * not permanently consume a one-shot schedule as though it ran.
   */
  runtimeAdmissionOpen(): boolean {
    return this.runtimeHost.isAdmissionOpen();
  }

  /**
   * Enqueue a scheduled prompt as a fresh turn for a session. The scheduler
   * calls this after binding validation passes. No `TelegramIntakeMessage` is
   * involved — scheduled prompts are synthetic and bypass Telegram
   * user-context preparation. The stale-runner guard applies: if the runner is
   * swapped before the queued turn starts, it aborts without side effects.
   *
   * If a runner already exists at enqueue time, its reference is captured and
   * the stale-runner guard checks it at execution time. If no runner exists at
   * enqueue time, the callback creates one via the async `getOrCreateRunner`
   * (memory context capture must complete before registration). This keeps the
   * method fire-and-forget — the scheduler does not await the model turn.
   *
   * Returns an admission handle when the runtime queue accepted the turn, or
   * `false` when runtime admission is closed. The handle reports whether the
   * queued entry reached execution before shutdown fenced it.
   */
  enqueueScheduledTurn(
    session: ConversationState,
    surface: Surface,
    content: PromptContent,
    onError?: (err: unknown) => void,
  ): boolean | ScheduledTurnAdmission {
    if (!this.runtimeHost.isAdmissionOpen()) {
      log.info("scheduled turn rejected: runtime admission closed", { sessionId: session.id });
      return false;
    }
    const buffer = this.createMessageBuffer(surface, session);
    // Warm work is tied to the registered runtime at admission. Cold work
    // starts with bootstrap binding/queue authority and must adopt the runner
    // that creation actually registered before model or visible effects.
    const existingRunner = this.runtimeHost.getRunner(session.id);
    let resolveStarted!: (started: boolean) => void;
    const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });

    const execute = async (authority: WorkAuthority): Promise<void> => {
      let runner: AgentRunner;
      if (existingRunner) {
        runner = existingRunner;
      } else {
        runner = await this.getOrCreateRunner(session, surface);
        if (!authority.adoptCurrentRunner(runner)) return;
      }
      if (!authority.isCurrent()) return;
      if (runner.isAbortTimedOut) {
        const error = new Error("Scheduled turn dropped: runner is wedged after abort timed out");
        log.warn(error.message, {
          sessionId: session.id,
        });
        // The scheduler owns durable schedule outcomes through onError. A
        // silent return here would let its start handle record this dropped
        // occurrence as successful.
        throw error;
      }
      await runner.prompt(content, buffer);
    };

    // Chain onto the per-session prompt queue so scheduled turns serialize
    // with user turns and deferred commands.
    const admitted = this.runtimeHost.schedule(
      session.id,
      existingRunner === null
        ? { kind: "bootstrap" }
        : { kind: "current-runtime", runner: existingRunner },
      execute,
      (err) => {
        onError?.(err);
      },
      {
        isPrompt: true,
        onStart: () => resolveStarted(true),
        onFenced: () => resolveStarted(false),
      },
    );
    if (!admitted) {
      log.info("scheduled turn rejected at queue admission", { sessionId: session.id });
    }
    return admitted
      ? { accepted: true, started }
      : false;
  }
}
