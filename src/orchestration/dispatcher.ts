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
import { parseSurfaceId, surfaceId, type Surface } from "../surface.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import type { DelegatedRuntimeContext } from "../delegated-work/mod.ts";
import type { SurfaceSettings } from "./conversation-lifecycle.ts";
import { PreparedRuntimeAssembler } from "./prepared-runtime.ts";
import type { PreparedSurfaceRuntimePlan } from "../agent/runtime-plan.ts";
import { CapabilityManifestToolSource } from "../agent/tool-assembly.ts";
import { ConversationRuntimeHost, type RuntimeDisposalOptions } from "./conversation-runtime-host.ts";
import type { SurfaceRuntimeAuthority } from "./surface-runtime-authority.ts";
export type { AttachmentSignal, AttachedWork, CurrentBindingGuard, SurfaceRuntimeAuthority } from "./surface-runtime-authority.ts";
export type { SurfaceSettings };

export interface ScheduledTurnAdmission {
  readonly accepted: true;
  /** Resolves false when shutdown fences the queued entry before it starts. */
  readonly started: Promise<boolean>;
}

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
      surfaceSettings: this.surfaceSettings,
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
      isCurrent: () =>
        this.runtimeHost.isRegisteredRunner(plan.conversationId, runner) &&
        this.surfaceRuntimeAuthority.isCurrentBinding(plan.surface, plan.conversationId),
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
   * Throws after completion when the runner was invalidated while the revived
   * subagent was running — the result is suppressed as stale.
   */
  async reviveSubagent(
    surface: Surface,
    session: ConversationState,
    subagentId: string,
    prompt: string,
  ): Promise<string> {
    const expectedSurfaceId = surfaceId(surface);

    const attached = await this.surfaceRuntimeAuthority.withCurrentBinding(
      surface,
      session.id,
      async (signal) => {
        const runner = this.runtimeHost.getRunner(session.id);
        if (runner === null) {
          throw new Error(
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

        return { result, runner };
      },
    );

    const result = await attached.result;
    if (attached.runner === undefined || !this.isRunnerCurrent(session.id, attached.runner)) {
      log.warn("revived subagent completed after its runtime was invalidated", {
        subagentId,
        sessionId: session.id,
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
    this.runtimeHost.assertAdmissionOpen();
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
      await this.surfaceRuntimeAuthority.assertCurrentBinding(surface, session.id);
      if (
        this.runtimeHost.isRegisteredRunner(session.id, existing) &&
        this.runtimeHost.surfaceIdFor(session.id) === expectedSurfaceId &&
        this.runtimeHost.skillContextFor(session.id)?.settingsFingerprint === snapshot.fingerprint &&
        this.surfaceSettings.getRuntimeSettings(surface).fingerprint === snapshot.fingerprint
      ) return existing;
      return this.getOrCreateRunner(session, surface);
    }

    const inFlight = this.runtimeHost.creationFor(session.id);
    if (
      inFlight &&
      inFlight.surfaceId === expectedSurfaceId &&
      inFlight.settingsFingerprint === snapshot.fingerprint
    ) return inFlight.promise;

    const creation = this.runtimeHost.reserveCreation(
      session.id,
      expectedSurfaceId,
      snapshot.fingerprint,
    );
    const creationPromise = creation.promise;
    this.doCreateAndRegisterRunner(session, surface, snapshot, creation)
      .then(creation.resolve, creation.reject)
      .finally(() => this.runtimeHost.finishCreation(session.id, creationPromise, creation));
    return creationPromise;
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
    // reservation, so a stale plan cannot resurrect afterward.
    if (!this.runtimeHost.isCurrentCreation(session.id, creation.promise)) {
      throw new Error(`stale runtime creation for conversation ${session.id}: invalidated before registration`);
    }
    if (this.surfaceSettings.getRuntimeSettings(surface).fingerprint !== plan.settingsFingerprint) {
      throw new Error(`stale runtime creation for conversation ${session.id}: Surface settings changed before registration`);
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

  private isRunnerCurrent(conversationId: string, runner: AgentRunner): boolean {
    if (!this.runtimeHost.isRegisteredRunner(conversationId, runner)) return false;
    if (this.runtimeHost.isInternalRuntime(conversationId)) return true;
    const sid = this.runtimeHost.surfaceIdFor(conversationId);
    if (sid === undefined) return false;
    try {
      return this.surfaceRuntimeAuthority.isCurrentBinding(parseSurfaceId(sid), conversationId);
    } catch (error) {
      log.error("runtime binding authority check failed", {
        conversationId,
        surfaceId: sid,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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
   * Enqueue `run` on the per-session promise chain so work serializes. The
   * `isCurrent()` callback lets `run` detect that its runner has been swapped
   * out (by `/new`/`/resume`) and abort before side effects. `onError` handles
   * errors that escape `run`, gated by the same staleness check.
   *
   * This is the single serialization point shared by `/queue`, media prompts,
   * deferred commands, and scheduled turns.
   */
  schedulePrompt(
    conversation: ConversationState,
    runner: AgentRunner,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    opts: { isPrompt?: boolean } = {},
  ): boolean {
    return this.schedulePromptById(
      conversation.id,
      () => this.isRunnerCurrent(conversation.id, runner),
      run,
      onError,
      opts,
    );
  }

  /**
   * Serialize a lifecycle command behind current work without making the
   * disposed runner its authority. Same-binding runtime invalidation (for
   * example `/model`) preserves these commands; a binding change still makes
   * them stale before they can mutate state.
   */
  scheduleCommand(
    conversation: ConversationState,
    surface: Surface,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
  ): boolean {
    return this.schedulePromptById(
      conversation.id,
      () => this.surfaceRuntimeAuthority.isCurrentBinding(surface, conversation.id),
      run,
      onError,
      { isPrompt: false },
    );
  }

  /** Shared queue mechanics; callers supply the lifetime-specific authority check. */
  private schedulePromptById(
    sessionId: string,
    isCurrent: () => boolean,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    opts: { isPrompt?: boolean; onFenced?: () => void } = {},
  ): boolean {
    return this.runtimeHost.schedule(sessionId, isCurrent, run, onError, opts);
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

  /**
   * Cancel the queued-but-not-yet-started prompt for a session, if one exists.
   * This is the complement to `isPromptPending`: it reaches a turn that has
   * been scheduled through `schedulePrompt` but has not yet started streaming,
   * so `runner.isStreaming` is still false and `interruptAndCascade` would not
   * abort it. The runner's `abort()` is invoked; the agent runner uses this
   * signal to abort a turn before it starts (see `AgentRunner.abort`).
   * Returns true when a pending prompt was found and canceled.
   *
   * Note: this does not cascade to subagents. The session remains alive and
   * its subagents may continue doing useful work.
   */
  async cancelPending(sessionId: string): Promise<boolean> {
    return this.runtimeHost.cancelPending(sessionId);
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

    const admitted = this.schedulePromptById(
      session.id,
      () => this.runtimeHost.isRegisteredRunner(session.id, runner!) && this.runtimeHost.isInternalRuntime(session.id),
      async (isCurrent) => {
        await runner.prompt(content, sink);
        if (isCurrent()) complete(captured.join(""));
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
    // Capture the runner reference at enqueue time if one exists. This is the
    // stale-runner guard: if the runner is disposed (e.g. by /new) before the
    // queued scheduled turn starts, the guard aborts the turn without creating
    // a new runner. If no runner exists at enqueue time, the callback creates
    // one via getOrCreateRunner (async capture).
    const existingRunner = this.runtimeHost.getRunner(session.id);
    let resolveStarted!: (started: boolean) => void;
    const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });

    const execute = async (): Promise<void> => {
      let runner: AgentRunner;
      if (existingRunner) {
        // Stale-runner guard: if the runner was swapped after enqueue, abort
        // before producing user-visible side effects.
        if (!this.isRunnerCurrent(session.id, existingRunner)) return;
        runner = existingRunner;
      } else {
        runner = await this.getOrCreateRunner(session, surface);
        // Recheck after async creation: if the runner was swapped during
        // capture, abort.
        if (!this.isRunnerCurrent(session.id, runner)) return;
      }
      if (runner.isAbortTimedOut) {
        log.warn("scheduled turn dropped: runner is wedged after abort timed out", {
          sessionId: session.id,
        });
        return;
      }
      await runner.prompt(content, buffer);
    };

    // Chain onto the per-session prompt queue so scheduled turns serialize
    // with user turns and deferred commands.
    const admitted = this.runtimeHost.schedule(
      session.id,
      () => existingRunner === null || this.isRunnerCurrent(session.id, existingRunner),
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
