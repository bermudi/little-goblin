/**
 * Agent runner module.
 * Orchestrates LLM calls, tool use, and turn management.
 */

import {
  type ToolDefinition,
  type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { AgentEventHandler } from "./event-handler.ts";
import type { TurnCallbacks } from "./events.ts";
export { appendAssistantTranscriptEntry } from "./events.ts";
export type { TurnCallbacks } from "./events.ts";
import { resolveModel, type ResolvedModel } from "./models.ts";
import { type GoblinSystemPrompt, buildGoblinSystemPrompt } from "./system-prompt.ts";
import { type PreparedSurfaceRuntimePlan } from "./runtime-plan.ts";
import type { SurfaceCustomToolsSource } from "./tool-assembly.ts";
import {
  MemoryStore,
  EmbeddingProvider,
  formatRelevantMemory,
  type CapturedMemoryContext,
  type InternalMemoryContext,
} from "../memory/mod.ts";
import { DreamingPipeline } from "../memory/dreaming.ts";
import { MetricsStore } from "../metrics/mod.ts";
import { type GenericSubagentInheritance } from "../subagents/mod.ts";
import type { DelegatedRuntimeContext } from "../delegated-work/mod.ts";
import type { Surface } from "../surface.ts";
import { AgentBackend, AgentBackendOptions, PiAgentBackend } from "./backend.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { environmentCwd } from "../sessions/environment.ts";
import {
  cloneSkillPolicy,
  resolveSkillSet,
  DEFAULT_SKILL_POLICY,
  type ResolvedSkillSet,
  type SkillPolicy,
} from "./skills/mod.ts";

/**
 * Shared fields for all `AgentRunner` construction variants.
 */
interface AgentRunnerOptionsBase {
  cfg: Config;
  sessionId: string;
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  /**
   * Dreaming pipeline to use for background memory promotion after completed
   * turns. When absent, a default `DreamingPipeline` is constructed from
   * `cfg.goblinHome` and the runner's `MemoryStore`.
   */
  dreamingPipeline?: DreamingPipeline;
  /**
   * Shared embedding provider. When supplied, the runner creates a private
   * `MemoryStore` connection that uses this provider for vector indexing.
   */
  embeddingProvider?: EmbeddingProvider;
  /** Runtime authority used to classify generic delegated work as attached. */
  delegatedRuntimeContext?: DelegatedRuntimeContext;
  /** Optional pre-built memory store (tests may inject one). */
  memoryStore?: MemoryStore;
  /**
   * Factory for the backend. Defaults to the real `PiAgentBackend`. Tests can
   * inject a fake backend to observe calls without constructing the real SDK.
   */
  backendFactory?: (opts: AgentBackendOptions) => AgentBackend;
}

/**
 * Options for constructing a Surface-backed `AgentRunner`. The memory context
 * is a {@link CapturedMemoryContext} and the Telegram {@link Surface} is
 * required — schedule, subagent, and external-agent tools need it for delivery.
 */
export interface SurfaceAgentRunnerOptions extends AgentRunnerOptionsBase {
  /** Complete immutable runtime input prepared before construction. */
  plan: PreparedSurfaceRuntimePlan;
  /**
   * Encapsulates the capability dependency bundle (schedule/subagent/
   * external-agent/mcp runners plus the manifest) behind one interface. The
   * runner consumes the assembled tools rather than carrying those deps.
   */
  surfaceToolSource: SurfaceCustomToolsSource;
  /** Mandatory lifecycle authority for every Surface-backed effect. */
  isCurrent: () => boolean;
}

/**
 * Options for constructing an internal `AgentRunner` (e.g. the dreaming
 * extractor). The memory context is an {@link InternalMemoryContext} and no
 * Telegram Surface is permitted — internal work has no ordinary active-memory
 * write target and no delivery surface.
 */
export interface InternalAgentRunnerOptions extends AgentRunnerOptionsBase {
  memoryContext: InternalMemoryContext;
  customTools: ToolDefinition[];
  /** Immutable environment of the Surface-free internal session. */
  executionEnvironment: ExecutionEnvironment;
  modelName?: string;
  thinkingLevel?: ThinkingLevel;
  skillPolicy?: SkillPolicy;
  resolvedSkills?: ResolvedSkillSet;
  /** Optional deterministic model injection retained for internal runtimes and tests. */
  resolvedModel?: ResolvedModel;
  surface?: never;
  plan?: never;
  /** Internal runtimes are explicitly Surface-free and need no binding guard. */
  isCurrent?: never;
}

/**
 * Discriminated union: a `CapturedMemoryContext` requires a `Surface`, and an
 * `InternalMemoryContext` forbids one. Invalid combinations are unconstructible.
 */
export type AgentRunnerOptions = SurfaceAgentRunnerOptions | InternalAgentRunnerOptions;

/** Thrown when the resolved model does not support the content types present in a prompt. */
export class ModelNotCapableError extends Error {
  constructor(
    public readonly modelName: string,
    public readonly missingCapability: string,
  ) {
    super(`Model "${modelName}" does not support ${missingCapability} input.`);
  }
}

/**
 * Extract prompt text for snapshot relevant-memory scoring. Plain-string
 * prompts pass through; multimodal prompts contribute the concatenation of
 * their text blocks. Image-only prompts yield an empty string (no text to
 * score against).
 */
function extractPromptText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Structural late-steer race; callers may queue fallback work without
 * parsing an error message. */
export class RunnerNotStreamingError extends Error {
  constructor() {
    super("Cannot steer: session is not streaming.");
    this.name = "RunnerNotStreamingError";
  }
}

/**
 * AgentRunner wraps a pi AgentSession for a single goblin session.
 * Manages lazy initialization and event dispatch.
 */
export class AgentRunner {
  private cfg: Config;
  private sessionId: string;
  private customTools: ToolDefinition[];
  /** Assembles the Surface custom-tool list from the capability manifest; null
   * for internal (surface-free) runtimes that use injected tools. */
  private readonly surfaceToolSource: SurfaceCustomToolsSource | null;
  private isCurrent: () => boolean;
  private backend: AgentBackend;
  private readonly eventHandler: AgentEventHandler;
  private memoryStore: MemoryStore;
  private ownsMemoryStore: boolean;
  private dreamingPipeline: DreamingPipeline;
  /**
   * The captured runtime memory context. For Surface-backed runners this is a
   * `CapturedMemoryContext` carrying the projected ActiveScope, caller, frozen
   * summary, and deduplication bodies. For internal runners (dreaming
   * extraction) this is an `InternalMemoryContext` with no Surface and no
   * memory tools.
   *
   * Lazy pi `AgentSession` initialization consumes this capture without
   * rereading the store or resolving routing. Disposing and replacing the
   * runner is the only way to change its memory context.
   */
  public readonly memoryContext: CapturedMemoryContext | InternalMemoryContext;
  private getTopicName: ((chatId: number, topicId: number) => Promise<string | null>) | undefined;
  private topicNameCache = new Map<string, string | null>();
  private executionEnvironment: ExecutionEnvironment;
  private skillPolicy: SkillPolicy;
  private resolvedSkills: ResolvedSkillSet | null;
  private readonly preparedPlan: PreparedSurfaceRuntimePlan | null;
  /** Fixed at construction; Surface preference changes create a new runtime. */
  private readonly _modelName: string | undefined;
  /** Fixed at construction; Surface preference changes create a new runtime. */
  private readonly thinkingLevel: ThinkingLevel | undefined;
  private resolvedModel: ResolvedModel | null = null;
  private metricsStore: MetricsStore;
  /** The goblin system prompt value (text + provenance of loaded prompt files). */
  private goblinSystemPrompt: GoblinSystemPrompt | null = null;
  /**
   * Sticky flag set by the interrupt layer when a prior `abort()` did not
   * resolve within the cascade timeout. Once set, `isStreaming` reports
   * false and `abort()` is a no-op — we've already given up on the
   * in-flight abort, so a second call (from another cancel-capable
   * command) would just hit pi's abort path again on a session in an
   * undefined state.
   */
  private _abortTimedOut: boolean = false;
  /**
   * Set by `abort()` when it is called before the first `prompt()` has
   * initialized the backend. The next `prompt()` call checks this flag and
   * throws, so a queued turn that has not yet started can be canceled even
   * though the backend is not yet initialized.
   */
  private _abortBeforeInit: boolean = false;
  /** True while `prompt()` is in progress (including initialization). */
  private _prompting: boolean = false;
  /** True while the backend is being initialized (between init() start and end). */
  private _initInProgress: boolean = false;
  /** Captured runtime identity passed to attached delegated-work tools. */
  public readonly delegatedRuntimeContext: DelegatedRuntimeContext | null;

  /** Exposed for the interrupt layer and intake. */
  get isAbortTimedOut(): boolean {
    return this._abortTimedOut;
  }

  /** True while the runner is actively processing a `prompt()` call. */
  get isPrompting(): boolean {
    return this._prompting;
  }

  /** The session metrics store. Exposed for diagnostics and tests. */
  get metrics(): MetricsStore {
    return this.metricsStore;
  }

  /** If a cancel arrived before the first prompt, clear the flag and throw. */
  private throwIfAbortedBeforeInit(): void {
    if (this._abortBeforeInit) {
      this._abortBeforeInit = false;
      throw new Error("Turn aborted before it started.");
    }
  }

  /**
   * Single authority fence for every Surface-backed side effect. Internal
   * runners install the explicit always-current guard in the constructor.
   */
  private assertCurrent(): void {
    if (!this.isCurrent()) {
      throw new Error("AgentRunner runtime is no longer current on its surface.");
    }
  }

  /** Run an async boundary only while this runtime remains authoritative. */
  private async awaitCurrent<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    const result = await operation();
    this.assertCurrent();
    return result;
  }

  /** Wrap every agent-visible tool so stale runtimes cannot start or return tool work. */
  private guardTool(tool: ToolDefinition): ToolDefinition {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (...args: Parameters<typeof execute>) => {
        this.assertCurrent();
        const result = await execute(...args);
        this.assertCurrent();
        return result;
      },
    };
  }

  constructor(opts: AgentRunnerOptions) {
    this.cfg = opts.cfg;
    this.sessionId = opts.sessionId;
    this.preparedPlan = "plan" in opts && opts.plan !== undefined ? opts.plan : null;
    this.memoryContext = this.preparedPlan !== null
      ? this.preparedPlan.memoryContext
      : (opts as InternalAgentRunnerOptions).memoryContext;
    // Injected tools for internal runtimes. Surface runtimes assemble their
    // tools from the capability manifest in init(), so this is empty for them.
    this.customTools = this.preparedPlan === null
      ? (opts as InternalAgentRunnerOptions).customTools
      : [];
    this.surfaceToolSource = this.preparedPlan !== null
      ? (opts as SurfaceAgentRunnerOptions).surfaceToolSource
      : null;
    this.delegatedRuntimeContext = opts.delegatedRuntimeContext ?? null;
    this.isCurrent = this.memoryContext.kind === "surface"
      ? (opts as SurfaceAgentRunnerOptions).isCurrent
      : () => true;
    this.getTopicName = opts.getTopicName;
    const internal = opts as InternalAgentRunnerOptions;
    this.executionEnvironment = this.preparedPlan?.executionEnvironment ?? internal.executionEnvironment;
    this.skillPolicy = cloneSkillPolicy(this.preparedPlan?.skillPolicy ?? internal.skillPolicy ?? DEFAULT_SKILL_POLICY);
    this.resolvedSkills = this.preparedPlan?.resolvedSkills ?? internal.resolvedSkills ?? null;
    this._modelName = this.preparedPlan?.modelName ?? internal.modelName ?? (internal.resolvedModel ? `${internal.resolvedModel.model.provider}/${internal.resolvedModel.model.id}` : undefined);
    this.thinkingLevel = this.preparedPlan?.thinkingLevel ?? internal.thinkingLevel;
    this.resolvedModel = this.preparedPlan?.resolvedModel ?? internal.resolvedModel ?? null;
    this.metricsStore = new MetricsStore(opts.cfg.goblinHome, this.sessionId);
    this.eventHandler = new AgentEventHandler({
      sessionId: this.sessionId,
      goblinHome: opts.cfg.goblinHome,
      transcriptWriterContext: this.memoryContext.kind === "surface"
        ? { kind: "surface", sourceSurfaceId: this.memoryContext.authority.sourceSurfaceId }
        : { kind: "internal" },
      metricsStore: this.metricsStore,
      toolCwd: environmentCwd(this.executionEnvironment, opts.cfg.goblinHome),
      surface: this.preparedPlan?.surface,
      isCurrent: this.isCurrent,
    });
    this.ownsMemoryStore = opts.memoryStore === undefined;
    this.memoryStore =
      opts.memoryStore ??
      new MemoryStore(
        opts.cfg.goblinHome,
        this.metricsStore,
        opts.embeddingProvider ? { embeddings: opts.embeddingProvider } : undefined,
      );
    this.dreamingPipeline = opts.dreamingPipeline ??
      new DreamingPipeline({ goblinHome: opts.cfg.goblinHome, store: this.memoryStore, metrics: this.metricsStore });
    const backendOpts: AgentBackendOptions = {
      cfg: this.cfg,
      sessionId: this.sessionId,
      onEvent: (event) => this.eventHandler.handle(event),
    };
    this.backend = opts.backendFactory?.(backendOpts) ?? new PiAgentBackend(backendOpts);
  }

  /**
   * Lazy initialization of the backend.
   * Called on first prompt() or compact().
   */
  private async init(): Promise<void> {
    this.assertCurrent();
    if (this.backend.isInitialized) return;
    this._initInProgress = true;
    try {
      this.throwIfAbortedBeforeInit();

      const home = this.cfg.goblinHome;
      const cwd = this.preparedPlan?.cwd ?? environmentCwd(this.executionEnvironment, home);
      const resolvedModel = this.preparedPlan?.resolvedModel ?? this.resolvedModel ?? resolveModel({ ...this.cfg, modelName: this._modelName ?? this.cfg.modelName });
      this.resolvedModel = resolvedModel;

      // Surface runtimes consume the complete prompt and exact skills captured
      // before construction. Only the structurally unchanged internal path may
      // use lazy compatibility preparation.
      const goblinSystemPrompt = this.preparedPlan?.systemPrompt ?? await this.awaitCurrent(() => buildGoblinSystemPrompt({
        home,
        executionEnvironment: this.executionEnvironment,
      }));
      this.goblinSystemPrompt = goblinSystemPrompt;

      const resolvedSkills = this.preparedPlan?.resolvedSkills ?? this.resolvedSkills ?? await this.awaitCurrent(() =>
        resolveSkillSet(this.executionEnvironment, this.skillPolicy, home, { captureSnapshots: false }),
      );
      this.resolvedSkills = resolvedSkills;
      if (resolvedSkills.diagnostics.length > 0) {
        log.debug("Skill catalog diagnostics", {
          sessionId: this.sessionId,
          count: resolvedSkills.diagnostics.length,
        });
      }

      // Surface runtimes obtain their custom tools from the injected tool
      // source, which encapsulates the capability dependency bundle behind one
      // interface. Internal runtimes use their injected tools only; they share
      // this module but not this decision procedure.
      let tools: ToolDefinition[];
      if (this.surfaceToolSource !== null) {
        tools = await this.surfaceToolSource.assemble({
          memoryStore: this.memoryStore,
          metricsStore: this.metricsStore,
          delegatedRuntimeContext: this.delegatedRuntimeContext,
          genericSubagentInheritance: this.genericSubagentInheritance,
          resolveTopicName: (chatId, topicId) => this.cachedTopicName(chatId, topicId),
          guardTool: (tool) => this.guardTool(tool),
          isCurrent: this.isCurrent,
          sendStatusUpdate: (msg) => this.eventHandler.sendStatusUpdate(msg),
          awaitCurrent: (op) => this.awaitCurrent(op),
        });
      } else {
        tools = this.customTools.map((tool) => this.guardTool(tool));
      }

      let systemPrompt = this.preparedPlan?.prompt ?? goblinSystemPrompt.prompt;
      if (this.preparedPlan === null && this.memoryContext.kind === "surface") {
        const frozenSummary = this.memoryContext.frozenSummary;
        if (frozenSummary !== null) systemPrompt = `${systemPrompt}\n\n${frozenSummary}`;
      }

      this.throwIfAbortedBeforeInit();
      await this.awaitCurrent(() => this.backend.init({
        resolvedModel,
        thinkingLevel: this.thinkingLevel ?? resolvedModel.thinkingLevel,
        customTools: tools,
        guardBuiltInTool: (tool) => this.guardTool(tool),
        systemPrompt,
        cwd,
        resolvedSkills,
      }));
      this.throwIfAbortedBeforeInit();
      log.debug("AgentRunner initialized", { sessionId: this.sessionId });
    } finally {
      this._initInProgress = false;
    }
  }

  /**
   * Send a prompt to the agent. Accepts plain text or multimodal content
   * blocks (text + images). Creates the session lazily on first call.
   *
   * Starts a new turn. MUST NOT be called while the runner is streaming —
   * use `followUp()` to steer a running turn. The guard makes the
   * steer-vs-new-turn contract explicit: calling `prompt()` on a streaming
   * runner would clobber the in-flight turn's event sink and text state.
   */
  async prompt(
    content: string | (TextContent | ImageContent)[],
    callbacks: TurnCallbacks,
  ): Promise<void> {
    this.assertCurrent();
    this._prompting = true;
    try {
      this.throwIfAbortedBeforeInit();
      await this.awaitCurrent(() => this.init());
      this.throwIfAbortedBeforeInit();
      this.assertCurrent();
      if (this.isAbortTimedOut) {
        throw new Error(
          "The previous turn is wedged after a failed abort. Use /new or /archive to recover.",
        );
      }
      if (this.isStreaming) {
        throw new Error("Cannot prompt while streaming; use followUp().");
      }

      this.eventHandler.beginTurn(callbacks);

      // Inject the `## relevant memory` per-turn aside computed from the
      // prompt text. Pi queues it and flushes alongside the next user message;
      // the system prompt stays frozen, preserving the provider prefix cache.
      // Steers do not pass prompt text and so never inject a relevant-memory
      // section. Internal runners (dreaming extraction) skip the aside — they
      // have no Surface-backed memory context.
      const promptText = extractPromptText(content);
      const memoryContext = this.memoryContext;
      if (memoryContext.kind === "surface") {
        const aside = await this.awaitCurrent(() => formatRelevantMemory({
          store: this.memoryStore,
          context: memoryContext,
          promptText,
          metrics: this.metricsStore,
        }));
        if (aside !== null) {
          await this.awaitCurrent(() => this.backend.sendCustomMessage(aside, { deliverAs: "nextTurn" }));
        }
      }

      const contentForModel = this.normalizeContentForModel(content);
      await this.awaitCurrent(() => this.backend.sendUserMessage(contentForModel));
    } finally {
      this._prompting = false;
    }
  }

  /**
   * Steer the running turn. Injects `content` into the model's context
   * mid-turn via pi's `AgentSession.followUp()` without resetting the
   * in-flight turn's `MessageBuffer` or accumulated text. No memory
   * snapshot is injected — the snapshot is per-turn, and the running turn
   * already received its snapshot at `prompt()` time.
   *
   * Accepts the same content shape as `prompt`. The bot layer decides
   * steer-vs-queue; the runner only exposes the two primitives.
   *
   * Validation is synchronous so a caller can attach the follow-up or
   * admit a fallback in one section before releasing Telegram admission.
   * Only the backend hand-off is async.
   */
  followUp(content: string | (TextContent | ImageContent)[]): Promise<void> {
    this.assertCurrent();
    if (!this.backend.isInitialized) {
      throw new Error("Cannot steer: session not initialized. Call prompt() first.");
    }
    if (!this.isStreaming) {
      throw new RunnerNotStreamingError();
    }
    const contentForModel = this.normalizeContentForModel(content);
    return this.awaitCurrent(() => this.backend.followUp(contentForModel));
  }

  private normalizeContentForModel(
    content: string | (TextContent | ImageContent)[],
  ): string | (TextContent | ImageContent)[] {
    if (typeof content === "string") return content;

    const model = this.resolvedModel?.model;
    const hasImage = content.some((part) => part.type === "image");

    if (hasImage && model !== undefined && !model.input.includes("image")) {
      throw new ModelNotCapableError(this.modelName, "image");
    }

    if (model?.provider !== "poe" || model.api !== "openai-completions") return content;
    if (!hasImage) return content;

    const text = content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return content;

    return [{ type: "text", text: "What do you see in this image?" }, ...content];
  }

  private async cachedTopicName(chatId: number, topicId: number): Promise<string | null> {
    const key = `${chatId}/${topicId}`;
    if (this.topicNameCache.has(key)) {
      return this.topicNameCache.get(key) ?? null;
    }
    const name = this.getTopicName === undefined
      ? null
      : await this.awaitCurrent(() => this.getTopicName!(chatId, topicId));
    this.topicNameCache.set(key, name);
    return name;
  }

  /**
   * True when the runner is active from a scheduling perspective (the
   * underlying pi `AgentSession` is mid-stream AND the previous abort did
   * not time out). False when the runner is idle OR when the previous
   * abort timed out (the runner is wedged). Callers should use
   * `isAbortTimedOut` to distinguish idle from wedged.
   */
  get isStreaming(): boolean {
    if (this._abortTimedOut) return false;
    return this.backend.isStreaming;
  }

  /**
   * Mark this runner's current abort as having timed out. Called by the
   * interrupt layer when `abort()` didn't resolve within the cascade
   * budget. Sticky until `dispose()`.
   */
  markAbortTimedOut(): void {
    this._abortTimedOut = true;
  }

  /**
   * True once `init()` has run (i.e. the first `prompt()` has primed the
   * backend). Callers can use this to distinguish "not yet initialized"
   * from genuinely-unobservable fields.
   */
  get isInitialized(): boolean {
    return this.backend.isInitialized;
  }

  /**
   * Names of tools currently active on the underlying backend.
   * Returns `null` when the backend has not been initialized yet (i.e. no
   * `prompt()` has run); callers should render that as "unavailable".
   */
  getActiveToolNames(): string[] | null {
    return this.backend.getActiveToolNames();
  }

  /**
   * Number of skills loaded by the backend.
   * Returns `null` when the backend has not been initialized yet.
   */
  get skillsLoaded(): number | null {
    return this.backend.getSkills()?.skills.length ?? null;
  }

  /**
   * Invocation authority inherited by generic subagent spawns and revivals.
   * Production Surface runtimes resolve it eagerly; lazy compatibility
   * runners expose `null` until initialization completes.
   */
  get genericSubagentInheritance(): GenericSubagentInheritance | null {
    if (this.resolvedSkills === null) return null;
    return {
      executionEnvironment: this.executionEnvironment,
      resolvedSkills: this.resolvedSkills,
    };
  }

  /**
   * Approximate context tokens used. Returns `null` when the backend has
   * not been initialized or when the token count is unknown (e.g. right
   * after compaction).
   */
  get contextTokens(): number | null {
    return this.backend.getContextUsage()?.tokens ?? null;
  }

  /**
   * Paths of context files loaded into the backend: goblin prompt files
   * (SOUL.md, AGENTS.md, project AGENTS.md) and any pi-loaded skills.
   * Returns `null` when the backend has not been initialized yet.
   */
  get contextFiles(): string[] | null {
    if (!this.backend.isInitialized) return null;
    const skills = this.backend.getSkills()?.skills ?? [];
    return [...(this.goblinSystemPrompt?.sources ?? []), ...skills.map((sk) => sk.filePath)];
  }

  /**
   * Configured model id (session override or config default).
   * Available even before the backend has been initialized.
   */
  get modelName(): string {
    return this._modelName ?? this.cfg.modelName;
  }

  /**
   * Abort the current agent operation.
   */
  async abort(): Promise<void> {
    if (this.isAbortTimedOut) return;
    if (this._initInProgress || !this.backend.isInitialized) {
      // The turn has been scheduled but `init()` has not yet completed (or
      // has not started). Stash the abort so the next `prompt()` aborts before
      // it produces side effects.
      this._abortBeforeInit = true;
      return;
    }
    await this.backend.abort();
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    await this.awaitCurrent(() => this.init());
    if (!this.backend.isInitialized) {
      throw new Error("Failed to initialize backend");
    }
    if (this.isAbortTimedOut) {
      throw new Error("Cannot compact because the previous abort timed out. Try /new or /archive.");
    }
    if (this.backend.isStreaming) {
      throw new Error("Cannot compact while the agent is still streaming. Try /cancel first.");
    }
    return await this.awaitCurrent(() => this.backend.compact(customInstructions));
  }

  /**
   * Clean up resources. Awaits any in-flight dreaming light sleep so that a
   * disposing runner does not leave background writes that race with session
   * archive or rebinding.
   */
  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    try {
      // Fence events synchronously. Pi may deliver callbacks after dispose()
      // starts, and those callbacks must not write transcripts or metrics.
      this.eventHandler.close();
    } catch (err) {
      failures.push(err);
      log.error("AgentRunner event handler close failed", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.dreamingPipeline.awaitSettled(this.sessionId);
    } catch (err) {
      failures.push(err);
      log.error("AgentRunner dreaming pipeline await failed during dispose", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.backend.dispose();
    } catch (err) {
      failures.push(err);
      log.error("AgentRunner dispose failed", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.ownsMemoryStore) {
      try {
        this.memoryStore.close();
      } catch (err) {
        failures.push(err);
        log.error("AgentRunner memory store close failed", {
          sessionId: this.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "AgentRunner cleanup failed");
  }
}
