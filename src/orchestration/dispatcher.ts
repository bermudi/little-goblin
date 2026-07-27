import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { AgentRunner, type TurnCallbacks } from "../agent/mod.ts";
import {
  MemoryStore,
  EmbeddingProvider,
  DreamingPipeline,
  captureRuntimeMemoryContext,
  type CapturedMemoryContext,
  type InternalMemoryContext,
} from "../memory/mod.ts";
import type { SessionState } from "../sessions/types.ts";
import { dmSurface, surfaceId, type Surface, type SurfaceId } from "../surface.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import { environmentsEqual, type ExecutionEnvironment } from "../sessions/environment.ts";

/** Prompt content accepted by a runner: a string or multimodal parts. */
export type PromptContent = string | (TextContent | ImageContent)[];

/** Metadata stored alongside each queued prompt chain entry. */
interface PromptQueueEntry {
  /** True for actual prompt turns; false for deferred commands. */
  isPrompt: boolean;
}

/** Maximum time `disposeRunner` waits for the subagent cascade to settle. */
const DISPOSE_RUNNER_CANCEL_TIMEOUT_MS = 10_000;

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

/**
 * Surface-scoped settings the dispatcher needs to build a runner. This is a
 * narrow subset of `ConversationLifecycle`'s settings seam; the dispatcher
 * does not depend on `SessionManager`.
 */
export interface SurfaceSettings {
  effectiveEnvironment(surface: Surface): ExecutionEnvironment;
}

export interface TurnDispatcherOptions {
  cfg: Config;
  surfaceSettings: SurfaceSettings;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  agentRunners: Map<string, AgentRunner>;
  promptQueues?: Map<string, Promise<void>>;
  promptQueueMeta?: Map<string, PromptQueueEntry>;
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
  createMessageBuffer: (surface: Surface, session?: SessionState) => TurnSink;
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
   * Optional binding authority inspector: returns the conversation id currently
   * bound to the given Surface, or `undefined` if no conversation is bound.
   * Used as the binding-generation recheck after memory capture: if the
   * binding changes between the start and end of capture, the stale creation
   * is discarded rather than registered. Wired by the caller (intake) after
   * the conversation lifecycle is constructed.
   */
  bindingInspector?: (surface: Surface) => string | undefined;
}

/**
 * Shared turn dispatcher: owns `AgentRunner` creation, per-session fresh-turn
 * queues, turn-sink creation, and runner disposal. Both Telegram intake and the
 * scheduled-turn scheduler dispatch through this so a due scheduled prompt and
 * a Telegram message serialize through the same per-session chain.
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
  private readonly runners: Map<string, AgentRunner>;
  /** Surface a runner was created for, keyed by session/conversation id. */
  private readonly runnerSurfaceIds: Map<string, SurfaceId>;
  /**
   * In-flight runner creation, keyed by session id. Stores the promise AND
   * the destination surface id. Deduplicates concurrent creation only for
   * the same (session, surface) — a request for a different surface overwrites
   * the entry, causing the prior creation's post-capture recheck to fail.
   */
  private readonly inFlightCreations: Map<string, { promise: Promise<AgentRunner>; surfaceId: SurfaceId }>;
  private readonly promptQueues: Map<string, Promise<void>>;
  private readonly cfg: Config;
  private readonly surfaceSettings: SurfaceSettings;
  private readonly subagentRunner: SubagentRunner;
  private readonly memoryStore: MemoryStore;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly dreamingPipeline?: DreamingPipeline;
  private readonly createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  private readonly createMessageBufferFn: (surface: Surface, session?: SessionState) => TurnSink;
  private readonly createBetaToolsFn: (surface: Surface) => ToolDefinition[];
  private readonly getTopicName: (chatId: number, topicId: number) => Promise<string | null>;
  private readonly promptQueueMeta: Map<string, PromptQueueEntry>;
  private readonly scheduleStore: ScheduleStore | undefined;
  private readonly externalAgentRunner: ExternalAgentRunner | undefined;
  private readonly mcpRunner: McpRunner | undefined;
  private bindingInspector: ((surface: Surface) => string | undefined) | undefined;

  constructor(options: TurnDispatcherOptions) {
    this.cfg = options.cfg;
    this.surfaceSettings = options.surfaceSettings;
    this.subagentRunner = options.subagentRunner;
    this.memoryStore = options.memoryStore;
    this.embeddingProvider = options.embeddingProvider;
    this.dreamingPipeline = options.dreamingPipeline;
    this.runners = options.agentRunners;
    this.runnerSurfaceIds = new Map<string, SurfaceId>();
    this.inFlightCreations = new Map<string, { promise: Promise<AgentRunner>; surfaceId: SurfaceId }>();
    this.promptQueues = options.promptQueues ?? new Map<string, Promise<void>>();
    this.promptQueueMeta = options.promptQueueMeta ?? new Map<string, PromptQueueEntry>();
    this.createAgentRunner = options.createAgentRunner;
    this.createMessageBufferFn = options.createMessageBuffer;
    this.createBetaToolsFn = options.createBetaTools;
    this.getTopicName = buildGetTopicName(this.memoryStore);
    this.scheduleStore = options.scheduleStore;
    this.externalAgentRunner = options.externalAgentRunner;
    this.mcpRunner = options.mcpRunner;
    this.bindingInspector = options.bindingInspector;
  }

  /**
   * Set or replace the binding authority inspector. The caller (intake) wires
   * this after the conversation lifecycle is constructed, since the lifecycle
   * is created after the dispatcher and owns binding state.
   */
  setBindingInspector(inspector: (surface: Surface) => string | undefined): void {
    this.bindingInspector = inspector;
  }

  /**
   * Return the current runner for a session, or null if none exists. Replaces
   * direct reads of the (now-private) `runners` map.
   */
  getRunner(sessionId: string): AgentRunner | null {
    return this.runners.get(sessionId) ?? null;
  }

  /**
   * True when a runner is currently registered for a session. Replaces direct
   * `runners.has(...)` reads of the (now-private) map.
   */
  hasRunner(sessionId: string): boolean {
    return this.runners.has(sessionId);
  }

  /**
   * Construct a new Surface-backed `AgentRunner` from a completed memory
   * context capture. The caller is responsible for capturing the memory
   * context before calling this — the runner does not reread the store for
   * frozen summary or routing authority. Telegram delivery parameters are
   * derived from the provided `surface`.
   */
  createRunner(
    session: SessionState,
    surface: Surface,
    memoryContext: CapturedMemoryContext,
  ): AgentRunner {
    const surfaceEnv = this.surfaceSettings.effectiveEnvironment(surface);
    if (session.chatId !== 0 && !environmentsEqual(session.executionEnvironment, surfaceEnv)) {
      const sessionEnv = session.executionEnvironment;
      throw new Error(
        `environment mismatch: session ${session.id} is ${sessionEnv.kind === "project" ? sessionEnv.projectRoot : sessionEnv.kind}, surface ${surface.kind}:${surface.chatId} is ${surfaceEnv.kind === "project" ? surfaceEnv.projectRoot : surfaceEnv.kind}`,
      );
    }

    const betaTools = session.chatId === 0 ? [] : this.createBetaToolsFn(surface);
    const runnerOpts: ConstructorParameters<typeof AgentRunner>[0] = {
      cfg: this.cfg,
      sessionId: session.id,
      surface,
      memoryContext,
      customTools: betaTools,
      subagentRunner: session.chatId === 0 ? undefined : this.subagentRunner,
      getTopicName: this.getTopicName,
      executionEnvironment: session.executionEnvironment,
      modelName: session.modelName,
      thinkingLevel: session.thinkingLevel,
      scheduleStore: this.scheduleStore,
      externalAgentRunner: this.externalAgentRunner,
      mcpRunner: this.mcpRunner,
      embeddingProvider: this.embeddingProvider,
      dreamingPipeline: this.dreamingPipeline,
    };
    return this.createAgentRunner?.(runnerOpts) ?? new AgentRunner(runnerOpts);
  }

  /**
   * Return the existing runner for a session, creating one if none exists.
   * A runner is only reused when it was created for the same surface; if the
   * conversation has moved, the stale runner is disposed and a new one built
   * for the destination surface.
   *
   * Creation is asynchronous: the memory context capture (frozen summary,
   * ActiveScope projection, deduplication bodies) must complete before the
   * runner is registered. Concurrent creation requests for the same
   * (session, surface) are deduplicated via an in-flight promise — both
   * callers share one capture and one runner. A concurrent request for a
   * different surface on the same session overwrites the in-flight entry,
   * causing the prior creation's post-capture recheck to fail.
   *
   * After capture resolves, two rechecks guard registration:
   * 1. In-flight identity: if the in-flight entry no longer holds this
   *    creation's promise, a disposal or newer creation invalidated it.
   * 2. Binding authority: if a `bindingInspector` is wired, the binding for
   *    the surface must still point to the requested session. This catches
   *    stale callers whose binding was rotated (e.g. by `/new`) before the
   *    creation started — a case the in-flight identity check alone cannot
   *    detect because the entry was already cleared by the time the stale
   *    creation registers its own promise.
   */
  async getOrCreateRunner(session: SessionState, surface: Surface): Promise<AgentRunner> {
    const expectedSurfaceId = surfaceId(surface);
    const existing = this.runners.get(session.id);
    const existingSurfaceId = this.runnerSurfaceIds.get(session.id);
    if (existing && existingSurfaceId === expectedSurfaceId) {
      return existing;
    }

    // Deduplicate concurrent creation for the same (session, surface) only.
    // A different-surface request overwrites the entry, causing the prior
    // creation's recheck to fail.
    const inFlight = this.inFlightCreations.get(session.id);
    if (inFlight && inFlight.surfaceId === expectedSurfaceId) {
      return inFlight.promise;
    }

    let resolveCreation!: (runner: AgentRunner) => void;
    let rejectCreation!: (err: unknown) => void;
    const creationPromise = new Promise<AgentRunner>((resolve, reject) => {
      resolveCreation = resolve;
      rejectCreation = reject;
    });
    this.inFlightCreations.set(session.id, { promise: creationPromise, surfaceId: expectedSurfaceId });

    this.doCreateAndRegisterRunner(session, surface, expectedSurfaceId, creationPromise)
      .then(resolveCreation, rejectCreation)
      .finally(() => {
        const current = this.inFlightCreations.get(session.id);
        if (current?.promise === creationPromise) {
          this.inFlightCreations.delete(session.id);
        }
      });

    return creationPromise;
  }

  /**
   * Internal: capture memory context, recheck authority, create the runner,
   * and register it. Called by {@link getOrCreateRunner} after the in-flight
   * entry is registered.
   */
  private async doCreateAndRegisterRunner(
    session: SessionState,
    surface: Surface,
    expectedSurfaceId: SurfaceId,
    creationPromise: Promise<AgentRunner>,
  ): Promise<AgentRunner> {
    // Dispose existing runner through the single cleanup seam. The
    // `preserveInFlight` parameter keeps THIS creation's in-flight entry so
    // the post-capture recheck doesn't discard it. This awaits quiescence
    // (runner.dispose, subagent cancel, external-agent cancel) before
    // creating the replacement, so old and new runners never overlap.
    if (this.runners.has(session.id)) {
      await this.disposeRunner(session.id, creationPromise);
    }

    const memoryContext = await captureRuntimeMemoryContext({
      surface,
      caller: { kind: "main" },
      store: this.memoryStore,
      getTopicName: this.getTopicName,
    });

    // Recheck 1 — in-flight identity: if the in-flight entry no longer holds
    // this creation's promise, a disposal or newer (different-surface)
    // creation invalidated it.
    const currentInFlight = this.inFlightCreations.get(session.id);
    if (currentInFlight?.promise !== creationPromise) {
      throw new Error(
        `stale runtime creation for session ${session.id}: invalidated during capture`,
      );
    }

    // Recheck 2 — binding authority: if a binding inspector is wired, verify
    // the surface still points to the requested session. This catches stale
    // callers whose binding was rotated before the creation started — a case
    // the in-flight identity check alone cannot detect.
    if (this.bindingInspector) {
      const boundId = this.bindingInspector(surface);
      if (boundId !== session.id) {
        throw new Error(
          `stale runtime creation for session ${session.id}: binding for ${expectedSurfaceId} is ${boundId ?? "unbound"}`,
        );
      }
    }

    const runner = this.createRunner(session, surface, memoryContext);
    this.runners.set(session.id, runner);
    this.runnerSurfaceIds.set(session.id, expectedSurfaceId);
    log.debug("created runner for session", { sessionId: session.id, surfaceId: expectedSurfaceId });
    return runner;
  }

  /**
   * Build the turn sink for a surface via the injected factory. Always
   * delegates to `createMessageBufferFn` — there is no fallback, the factory
   * is mandatory at construction.
   */
  createMessageBuffer(surface: Surface, session?: SessionState): TurnSink {
    return this.createMessageBufferFn(surface, session);
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
    session: SessionState,
    runner: AgentRunner,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    opts: { isPrompt?: boolean } = {},
  ): void {
    const isCurrent = (): boolean => this.runners.get(session.id) === runner;
    const execute = async (): Promise<void> => {
      if (!isCurrent()) return;
      try {
        await run(isCurrent);
      } catch (err) {
        if (!isCurrent()) return;
        try {
          await onError(err);
        } catch (handlerErr) {
          log.error("prompt error handler failed", { error: String(handlerErr), sessionId: session.id });
        }
      }
    };
    const prior = this.promptQueues.get(session.id);
    const current = prior ? prior.then(execute, execute) : execute();
    const meta: PromptQueueEntry = { isPrompt: opts.isPrompt ?? true };
    this.promptQueues.set(session.id, current);
    this.promptQueueMeta.set(session.id, meta);
    void current.finally(() => {
      if (this.promptQueues.get(session.id) === current) this.promptQueues.delete(session.id);
      if (this.promptQueueMeta.get(session.id) === meta) this.promptQueueMeta.delete(session.id);
    });
  }

  /**
   * True when the session has a deferred command that has been scheduled but
   * not yet settled. State-mutating commands that queue should also queue when
   * a command is already pending, so they serialize after it.
   */
  isCommandPending(sessionId: string): boolean {
    const meta = this.promptQueueMeta.get(sessionId);
    return meta !== undefined && !meta.isPrompt;
  }

  /**
   * True when the session has a prompt turn that has been scheduled but not
   * yet started. This covers a coalescer-flushed prompt whose `handleText`
   * promise has scheduled but not yet started. Complements `runner.isStreaming`
   * and `runner.isPrompting`, which are false until `AgentRunner.prompt` is
   * actually called.
   */
  isPromptPending(sessionId: string): boolean {
    const meta = this.promptQueueMeta.get(sessionId);
    return meta !== undefined && meta.isPrompt;
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
    const meta = this.promptQueueMeta.get(sessionId);
    if (!meta || !meta.isPrompt) return false;
    const runner = this.getRunner(sessionId);
    if (runner && !runner.isStreaming) {
      await runner.abort();
    }
    return true;
  }

  /**
   * Dispose a session's runner and sever its prompt-queue chain so any queued
   * work for the stale runner aborts via the `isCurrent()` guard. Safe to call
   * when no runner exists (no-op).
   *
   * Disposes the runner and clears the queue first, then cancels any subagents
   * and external agents spawned by this session so orphaned work does not
   * outlive the runner.
   *
   * @param preserveInFlight When called from `doCreateAndRegisterRunner` to
   *   dispose an old runner before creating a replacement, pass the new
   *   creation's promise so the in-flight entry for it is preserved. Without
   *   this, the in-flight entry would be cleared and the new creation's
   *   post-capture recheck would discard it.
   */
  async disposeRunner(sessionId: string, preserveInFlight?: Promise<AgentRunner>): Promise<void> {
    const prior = this.runners.get(sessionId);
    this.runners.delete(sessionId);
    this.runnerSurfaceIds.delete(sessionId);
    // Clear the in-flight creation entry unless it matches the creation to
    // preserve (a replacement disposal). This is the stale-runner guard: a
    // capture in flight when the runner is disposed fails its post-capture
    // recheck and is discarded rather than registered.
    const currentInFlight = this.inFlightCreations.get(sessionId);
    if (!preserveInFlight || currentInFlight?.promise !== preserveInFlight) {
      this.inFlightCreations.delete(sessionId);
    }
    this.promptQueues.delete(sessionId);
    this.promptQueueMeta.delete(sessionId);

    // Await runner disposal and subagent/external cleanup, but track failure so
    // falsy throws (e.g. `throw undefined` or `throw null`) are still rethrown.
    let disposeErr: unknown;
    let disposeFailed = false;
    if (prior) {
      try {
        await prior.dispose();
      } catch (err) {
        disposeErr = err;
        disposeFailed = true;
        log.error("AgentRunner.dispose failed in disposeRunner", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cancel external agents owned by this session, then cancel subagents
    // spawned by this session, but don't block runner disposal indefinitely if
    // a cancel is stuck.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const externalCancelPromise = this.externalAgentRunner
      ? this.externalAgentRunner.cancelBySession(sessionId).catch((err) => {
          log.error("externalAgentRunner.cancelBySession failed in disposeRunner", {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        })
      : Promise.resolve();
    const cancelPromise = this.subagentRunner.cancelBySession(sessionId).catch((err) => {
      log.error("cancelBySession failed in disposeRunner", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("cancelBySession timed out in disposeRunner; continuing side effects", { sessionId });
        resolve();
      }, DISPOSE_RUNNER_CANCEL_TIMEOUT_MS);
    });
    try {
      await Promise.race([Promise.all([externalCancelPromise, cancelPromise]), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (disposeFailed) throw disposeErr;
    }
  }

  /**
   * Enqueue an internal turn for a non-chat session. Used for background
   * work such as the dreaming pipeline. The runner has no beta tools and writes
   * assistant text into an in-memory capture buffer. `onComplete(text)` is
   * called after `runner.prompt` resolves with the captured assistant text.
   */
  enqueueInternalTurn(
    session: SessionState,
    content: PromptContent,
    onComplete: (text: string) => void,
    onError: (err: unknown) => void,
  ): void {
    let runner = this.runners.get(session.id);
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
      this.runners.set(session.id, runner);
      // Internal runners have no Telegram Surface; record a sentinel so
      // hasRunner/getRunner continue to work. The surfaceId is not used for
      // memory scoping — the internal context has no ActiveScope.
      this.runnerSurfaceIds.set(session.id, surfaceId(dmSurface(1)));
    }

    const captured: string[] = [];
    const sink: TurnCallbacks = {
      onTextDelta: (text) => captured.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onStatusUpdate: () => {},
      onMessageStart: () => {},
      onMessageEnd: () => {},
      onAgentEnd: () => {},
    };

    this.schedulePrompt(
      session,
      runner,
      async () => {
        await runner.prompt(content, sink);
        onComplete(captured.join(""));
      },
      onError,
      { isPrompt: false },
    );
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
   * method sync and fire-and-forget — the scheduler does not need to await it.
   */
  enqueueScheduledTurn(
    session: SessionState,
    surface: Surface,
    content: PromptContent,
    onError?: (err: unknown) => void,
  ): void {
    const buffer = this.createMessageBuffer(surface, session);
    // Capture the runner reference at enqueue time if one exists. This is the
    // stale-runner guard: if the runner is disposed (e.g. by /new) before the
    // queued scheduled turn starts, the guard aborts the turn without creating
    // a new runner. If no runner exists at enqueue time, the callback creates
    // one via getOrCreateRunner (async capture).
    const existingRunner = this.runners.get(session.id);

    const execute = async (): Promise<void> => {
      try {
        let runner: AgentRunner;
        if (existingRunner) {
          // Stale-runner guard: if the runner was swapped after enqueue, abort
          // before producing user-visible side effects.
          if (this.runners.get(session.id) !== existingRunner) return;
          runner = existingRunner;
        } else {
          runner = await this.getOrCreateRunner(session, surface);
          // Recheck after async creation: if the runner was swapped during
          // capture, abort.
          if (this.runners.get(session.id) !== runner) return;
        }
        if (runner.isAbortTimedOut) {
          log.warn("scheduled turn dropped: runner is wedged after abort timed out", {
            sessionId: session.id,
          });
          return;
        }
        await runner.prompt(content, buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("scheduled turn failed", { error: msg, sessionId: session.id });
        onError?.(err);
      }
    };

    // Chain onto the per-session prompt queue so scheduled turns serialize
    // with user turns and deferred commands.
    const prior = this.promptQueues.get(session.id);
    const current = prior ? prior.then(execute, execute) : execute();
    const meta: PromptQueueEntry = { isPrompt: true };
    this.promptQueues.set(session.id, current);
    this.promptQueueMeta.set(session.id, meta);
    void current.finally(() => {
      if (this.promptQueues.get(session.id) === current) this.promptQueues.delete(session.id);
      if (this.promptQueueMeta.get(session.id) === meta) this.promptQueueMeta.delete(session.id);
    });
  }
}
