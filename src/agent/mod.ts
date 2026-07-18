/**
 * Agent runner module.
 * Orchestrates LLM calls, tool use, and turn management.
 */

import {
  type ToolDefinition,
  type AgentSessionEvent,
  type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { appendTranscriptEntry, dispatchAgentEvent, extractAssistantText } from "./events.ts";
import type { TurnCallbacks } from "./events.ts";
export { appendAssistantTranscriptEntry } from "./events.ts";
export type { TurnCallbacks } from "./events.ts";
import { resolveModel, type ResolvedModel } from "./models.ts";
import { type GoblinSystemPrompt, buildGoblinSystemPrompt } from "./system-prompt.ts";
import {
  MemoryStore,
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemorySearchTool,
  createMemoryWriteTool,
  formatSnapshot,
  resolveActiveScope,
} from "../memory/mod.ts";
import { MemoryReflector } from "../memory/reflector.ts";
import { MetricsStore, type MetricsUsage, type TurnMetricsEvent } from "../metrics/mod.ts";
import { type SubagentRunner } from "../subagents/mod.ts";
import type { ChatLocator } from "../sessions/types.ts";
import type { ActiveScope } from "../memory/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import { createScheduleTurnTool } from "../scheduler/tool.ts";
import { workdirPath } from "../workspace/paths.ts";
import { AgentBackend, AgentBackendOptions, PiAgentBackend } from "./backend.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import { createExternalAgentTool } from "../external-agents/tool.ts";
import { McpRunner, createMcpTools } from "../mcp/mod.ts";

/** Options for constructing an AgentRunner. */
export interface AgentRunnerOptions {
  cfg: Config;
  sessionId: string;
  locator: ChatLocator;
  customTools: ToolDefinition[];
  subagentRunner?: SubagentRunner;
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  /** Directory to use as cwd and agentDir. Falls back to goblin defaults when absent. */
  projectDir?: string;
  /** Session-scoped model override. Falls back to config default when absent. */
  modelName?: string;
  /** Session-scoped thinking level override. Falls back to model default when absent. */
  thinkingLevel?: ThinkingLevel;
  /** Queued notice to inject as context on the first prompt. Consumed once. */
  pendingProjectNotice?: string;
  /**
   * Memory reflector to use for background reflection after completed turns.
   * When absent, a default `MemoryReflector` is constructed from `cfg.goblinHome`
   * and the runner's `MemoryStore`. Tests inject a custom instance to control
   * candidate extraction and observe reflection state.
   */
  memoryReflector?: MemoryReflector;
  /** Shared schedule store. When present, the agent gets the `schedule_turn` tool. */
  scheduleStore?: ScheduleStore;
  /** Shared external agent runner. When present and enabled, the agent gets the `external_agent` tool. */
  externalAgentRunner?: ExternalAgentRunner;
  /** Shared MCP runner. When present and configured, the agent gets the `mcp_call` and `mcp_describe` tools. */
  mcpRunner?: McpRunner;
  /**
   * Pre-resolved model to use. When present, the runner skips `resolveModel()`
   * and uses this value directly. Useful for tests that drive the SDK with a
   * deterministic fake provider.
   */
  resolvedModel?: ResolvedModel;
  /**
   * Factory for the backend. Defaults to the real `PiAgentBackend`. Tests can
   * inject a fake backend to observe calls without constructing the real SDK.
   */
  backendFactory?: (opts: AgentBackendOptions) => AgentBackend;
}

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

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractUsage(message: Record<string, unknown>): MetricsUsage {
  const usage = typeof message.usage === "object" && message.usage !== null
    ? message.usage as Record<string, unknown>
    : {};
  const cost = typeof usage.cost === "object" && usage.cost !== null
    ? usage.cost as Record<string, unknown>
    : {};
  return {
    input: asFiniteNumber(usage.input),
    output: asFiniteNumber(usage.output),
    cacheRead: asFiniteNumber(usage.cacheRead),
    cacheWrite: asFiniteNumber(usage.cacheWrite),
    totalTokens: asFiniteNumber(usage.totalTokens),
    cost: {
      input: asFiniteNumber(cost.input),
      output: asFiniteNumber(cost.output),
      cacheRead: asFiniteNumber(cost.cacheRead),
      cacheWrite: asFiniteNumber(cost.cacheWrite),
      total: asFiniteNumber(cost.total),
    },
  };
}

function extractTimestamp(value: Record<string, unknown>): string | null {
  const ts = value.ts;
  if (typeof ts === "string" && ts.length > 0) return ts;

  const timestamp = value.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return timestamp;
  }

  return null;
}

function buildTurnMetricsEvent(args: {
  message: Record<string, unknown>;
  turnStart: string | null;
  turnEnd: string;
  toolCount: number;
  toolErrorCount: number;
  resolvedModel: ResolvedModel | null;
}): TurnMetricsEvent {
  const startTime = args.turnStart ?? args.turnEnd;
  const durationMs = Math.max(0, Date.parse(args.turnEnd) - Date.parse(startTime));
  const model = typeof args.message.model === "string" ? args.message.model : "";
  const provider = typeof args.message.provider === "string" ? args.message.provider : "";
  const api = typeof args.message.api === "string" ? args.message.api : "";
  const responseModel = typeof args.message.responseModel === "string" ? args.message.responseModel : undefined;
  const stopReason = args.message.stopReason;
  const errorMessage = args.message.errorMessage;
  const usage = extractUsage(args.message);

  return {
    type: "turn",
    turnStart: startTime,
    turnEnd: args.turnEnd,
    durationMs,
    model,
    provider,
    api,
    responseModel,
    usage,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    toolCount: args.toolCount,
    toolErrorCount: args.toolErrorCount,
    stopReason: typeof stopReason === "string" || stopReason === null ? stopReason : null,
    errorMessage: typeof errorMessage === "string" || errorMessage === null ? errorMessage : null,
  };
}

/**
 * AgentRunner wraps a pi AgentSession for a single goblin session.
 * Manages lazy initialization and event dispatch.
 */
export class AgentRunner {
  private cfg: Config;
  private sessionId: string;
  private locator: ChatLocator;
  private customTools: ToolDefinition[];
  private subagentRunner: SubagentRunner | null;
  private scheduleStore: ScheduleStore | undefined;
  private externalAgentRunner: ExternalAgentRunner | null;
  private mcpRunner: McpRunner | null;
  private backend: AgentBackend;
  private accumulatedText: string = "";
  private callbacks: TurnCallbacks | null = null;
  private memoryStore: MemoryStore;
  private memoryReflector: MemoryReflector;
  private activeScope: ActiveScope;
  private getTopicName: ((chatId: number, topicId: number) => Promise<string | null>) | undefined;
  private topicNameCache = new Map<string, string | null>();
  private projectDir: string | undefined;
  private _modelName: string | undefined;
  private _thinkingLevel: ThinkingLevel | undefined;
  private pendingProjectNotice: string | undefined;
  private resolvedModel: ResolvedModel | null = null;
  private metricsStore: MetricsStore;
  private turnStart: string | null = null;
  private turnToolCount = 0;
  private turnToolErrorCount = 0;
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

  constructor(opts: AgentRunnerOptions) {
    this.cfg = opts.cfg;
    this.sessionId = opts.sessionId;
    this.locator = opts.locator;
    this.activeScope = resolveActiveScope(opts.locator);
    this.customTools = opts.customTools;
    this.subagentRunner = opts.subagentRunner ?? null;
    this.scheduleStore = opts.scheduleStore;
    this.externalAgentRunner = opts.externalAgentRunner ?? null;
    this.mcpRunner = opts.mcpRunner ?? null;
    this.getTopicName = opts.getTopicName;
    this.projectDir = opts.projectDir;
    this._modelName = opts.modelName ?? (opts.resolvedModel ? `${opts.resolvedModel.model.provider}/${opts.resolvedModel.model.id}` : undefined);
    this._thinkingLevel = opts.thinkingLevel;
    this.pendingProjectNotice = opts.pendingProjectNotice;
    this.resolvedModel = opts.resolvedModel ?? null;
    this.metricsStore = new MetricsStore(opts.cfg.goblinHome, this.sessionId);
    // Construction is cheap (no I/O); the directory is created lazily on first write.
    this.memoryStore = new MemoryStore(opts.cfg.goblinHome, this.metricsStore);
    this.memoryReflector = opts.memoryReflector ??
      new MemoryReflector({ goblinHome: opts.cfg.goblinHome, store: this.memoryStore, metrics: this.metricsStore });
    const backendOpts: AgentBackendOptions = {
      cfg: this.cfg,
      sessionId: this.sessionId,
      onEvent: (event) => this.handleEvent(event),
    };
    this.backend = opts.backendFactory?.(backendOpts) ?? new PiAgentBackend(backendOpts);
  }

  /**
   * Lazy initialization of the backend.
   * Called on first prompt() or compact().
   */
  private async init(): Promise<void> {
    if (this.backend.isInitialized) return;
    this._initInProgress = true;
    try {
      this.throwIfAbortedBeforeInit();

      const home = this.cfg.goblinHome;
      const cwd = this.projectDir ?? workdirPath(home);
      const resolvedModel = this.resolvedModel ?? resolveModel({ ...this.cfg, modelName: this._modelName ?? this.cfg.modelName });
      this.resolvedModel = resolvedModel;

      const goblinSystemPrompt = await buildGoblinSystemPrompt({
        home,
        projectDir: this.projectDir,
      });
      this.goblinSystemPrompt = goblinSystemPrompt;

      const tools = await this.buildCustomTools();

      this.throwIfAbortedBeforeInit();
      await this.backend.init({
        resolvedModel,
        thinkingLevel: this._thinkingLevel ?? resolvedModel.thinkingLevel,
        customTools: tools,
        systemPrompt: goblinSystemPrompt.prompt,
        cwd,
      });
      this.throwIfAbortedBeforeInit();
      // Consumed — any later setThinkingLevel() calls go through the live backend.
      this._thinkingLevel = undefined;

      // Inject any queued project notice as a nextTurn custom message,
      // so the model knows the cwd changed when it sees the next user message.
      if (this.pendingProjectNotice) {
        await this.backend.sendCustomMessage(
          { customType: "project_notice", content: this.pendingProjectNotice, display: false, details: undefined },
          { deliverAs: "nextTurn" },
        );
        this.pendingProjectNotice = undefined;
      }

      log.debug("AgentRunner initialized", { sessionId: this.sessionId });
    } finally {
      this._initInProgress = false;
    }
  }

  private async buildCustomTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [
      ...this.customTools,
      createMemoryReadTool({ store: this.memoryStore, activeScope: this.activeScope }),
      createMemoryReadIndexTool({
        store: this.memoryStore,
        activeScope: this.activeScope,
        caller: { kind: "main" },
        getTopicName: (chatId, topicId) => this.cachedTopicName(chatId, topicId),
      }),
      createMemorySearchTool({
        store: this.memoryStore,
        activeScope: this.activeScope,
        caller: { kind: "main" },
        metrics: this.metricsStore,
      }),
      createMemoryWriteTool({ store: this.memoryStore, activeScope: this.activeScope }),
    ];

    if (this.scheduleStore) {
      tools.push(
        createScheduleTurnTool({
          store: this.scheduleStore,
          sessionId: this.sessionId,
          locator: this.locator,
          now: () => Date.now(),
        }),
      );
    }

    if (this.subagentRunner) {
      const { createSpawnSubagentTool, createReviveSubagentTool } = await import("../subagents/tool.ts");
      // Use delegating wrappers so the tools always forward to the current
      // turn's MessageBuffer — callbacks change per-prompt().
      tools.push(
        createSpawnSubagentTool(
          this.subagentRunner,
          0,
          this.sessionId,
          this.activeScope,
          (msg) => this.callbacks?.onStatusUpdate(msg),
          undefined,
        ),
      );
      tools.push(
        createReviveSubagentTool(
          this.subagentRunner,
          (msg) => this.callbacks?.onStatusUpdate(msg),
        ),
      );
    }

    if (this.externalAgentRunner && this.cfg.externalAgents?.backends.length && this.projectDir) {
      tools.push(
        createExternalAgentTool({
          runner: this.externalAgentRunner,
          sessionId: this.sessionId,
          projectDir: this.projectDir,
          enabledBackends: this.cfg.externalAgents.backends,
          onStatusUpdate: (msg) => this.callbacks?.onStatusUpdate(msg),
        }),
      );
    }

    if (this.mcpRunner && this.cfg.mcp) {
      await this.mcpRunner.ready;
      tools.push(...createMcpTools(this.mcpRunner));
    }

    return tools;
  }

  /**
   * Handle AgentSession events, dispatch to callbacks and log to transcript.
   */
  private handleEvent(event: AgentSessionEvent): void {
    // Append to transcript (compact message-level log)
    appendTranscriptEntry(this.sessionId, this.cfg.goblinHome, event);

    // Update session metrics from backend events. This runs before the
    // callback guard so turn and tool counters are recorded even when no
    // UI callbacks are bound.
    this.updateMetrics(event);

    if (!this.callbacks) return;

    // AgentRunner-specific text accumulation (not part of dispatch)
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        this.accumulatedText += ame.delta;
      }
    }

    // Reconciliation: when message_end arrives with the full assembled text,
    // compare it against the sum of streamed text_deltas for THIS message. If
    // deltas were lost upstream (provider streaming quirk, proxy merging
    // content_block_delta, network drop), the accumulated text is a strict
    // prefix of the final message. Emit a correcting delta for the missing
    // tail so the Telegram buffer self-heals regardless of what went wrong
    // upstream.
    //
    // The `startsWith` guard means we only patch truncation, never corruption:
    // if the deltas diverged from the final text, that's a different bug and
    // we must not silently rewrite what the user already saw.
    //
    // `accumulatedText` is reset after each assistant message_end so it tracks
    // per-message text — matching the per-message `message_end` semantics. A
    // turn with tool calls produces multiple assistant message_end events; each
    // carries only that message's text, not the cumulative turn text.
    if (event.type === "message_end") {
      const finalText = extractAssistantText(event as object);
      if (finalText !== undefined) {
        if (
          finalText !== this.accumulatedText &&
          finalText.startsWith(this.accumulatedText)
        ) {
          const missing = finalText.slice(this.accumulatedText.length);
          log.warn("reconciliation: emitting missing text tail", {
            accLen: this.accumulatedText.length,
            finalLen: finalText.length,
            missingLen: missing.length,
          });
          this.accumulatedText += missing;
          this.callbacks.onTextDelta(missing);
        }
        // Reset for the next assistant message in this turn.
        this.accumulatedText = "";
      }
    }

    dispatchAgentEvent(event, this.callbacks);

    // Schedule a fire-and-log background memory reflection pass after a
    // completed main-agent turn. Reflection reads the transcript tail after
    // a persisted cursor and never blocks the turn path — errors are caught
    // inside the reflector and logged, never thrown here. followUp() steers
    // a running turn without emitting an independent agent_end, so no
    // separate reflection pass is scheduled for steers.
    if (event.type === "agent_end") {
      this.memoryReflector.scheduleReflection(this.sessionId, this.activeScope);
    }
  }

  private updateMetrics(event: AgentSessionEvent): void {
    const e = event as unknown as Record<string, unknown>;

    switch (e.type) {
      case "agent_start": {
        this.turnStart = extractTimestamp(e) ?? this.turnStart ?? new Date().toISOString();
        this.turnToolCount = 0;
        this.turnToolErrorCount = 0;
        break;
      }
      case "turn_start": {
        this.turnStart = extractTimestamp(e) ?? this.turnStart ?? new Date().toISOString();
        this.turnToolCount = 0;
        this.turnToolErrorCount = 0;
        break;
      }
      case "tool_execution_start": {
        this.turnToolCount++;
        break;
      }
      case "tool_execution_end": {
        if (e.isError === true) {
          this.turnToolErrorCount++;
        }
        break;
      }
      case "turn_end": {
        const message = e.message;
        if (
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>).role === "assistant"
        ) {
          const messageRecord = message as Record<string, unknown>;
          const turnEnd = extractTimestamp(messageRecord) ?? extractTimestamp(e) ?? new Date().toISOString();
          const turn = buildTurnMetricsEvent({
            message: messageRecord,
            turnStart: this.turnStart,
            turnEnd,
            toolCount: this.turnToolCount,
            toolErrorCount: this.turnToolErrorCount,
            resolvedModel: this.resolvedModel,
          });
          this.metricsStore.record(turn);
          this.turnToolCount = 0;
          this.turnToolErrorCount = 0;
        }
        break;
      }
      case "agent_end": {
        this.turnStart = null;
        this.turnToolCount = 0;
        this.turnToolErrorCount = 0;
        break;
      }
    }
  }

  /**
   * Send a prompt to the agent. Accepts plain text or multimodal content
   * blocks (text + images). Creates the session lazily on first call.
   *
   * Starts a new turn. MUST NOT be called while the runner is streaming —
   * use `followUp()` to steer a running turn. The guard makes the
   * steer-vs-new-turn contract explicit: calling `prompt()` on a streaming
   * runner would clobber the in-flight turn's `this.callbacks` and
   * `this.accumulatedText`.
   */
  async prompt(
    content: string | (TextContent | ImageContent)[],
    callbacks: TurnCallbacks,
  ): Promise<void> {
    this._prompting = true;
    try {
      this.throwIfAbortedBeforeInit();
      await this.init();
      this.throwIfAbortedBeforeInit();
      if (this.isAbortTimedOut) {
        throw new Error(
          "The previous turn is wedged after a failed abort. Use /new or /archive to recover.",
        );
      }
      if (this.isStreaming) {
        throw new Error("Cannot prompt while streaming; use followUp().");
      }

      this.callbacks = callbacks;
      this.accumulatedText = "";
      this.turnStart = new Date().toISOString();
      this.turnToolCount = 0;
      this.turnToolErrorCount = 0;

      // Apply any pending thinking-level override before the turn starts.
      if (this._thinkingLevel !== undefined && this.backend.isInitialized) {
        this.backend.setThinkingLevel(this._thinkingLevel);
        this._thinkingLevel = undefined;
      }

      // Inject the curated memory snapshot as a per-turn aside.
      // Pi queues it and flushes alongside the next user message; the system
      // prompt stays frozen, preserving the provider prefix cache. When prompt
      // text is available it drives a bounded `## relevant memory` section so
      // the snapshot can surface related entries from other scopes. Steers do
      // not pass prompt text and so never inject a relevant-memory section.
      const promptText = extractPromptText(content);
      const aside = await formatSnapshot({
        store: this.memoryStore,
        activeScope: this.activeScope,
        caller: { kind: "main" },
        getTopicName: (chatId, topicId) => this.cachedTopicName(chatId, topicId),
        promptText,
        metrics: this.metricsStore,
      });
      if (aside !== null) {
        await this.backend.sendCustomMessage(aside, { deliverAs: "nextTurn" });
      }

      const contentForModel = this.normalizeContentForModel(content);
      await this.backend.sendUserMessage(contentForModel);
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
   */
  async followUp(content: string | (TextContent | ImageContent)[]): Promise<void> {
    if (!this.backend.isInitialized) {
      throw new Error("Cannot steer: session not initialized. Call prompt() first.");
    }
    if (!this.isStreaming) {
      throw new Error("Cannot steer: session is not streaming.");
    }
    const contentForModel = this.normalizeContentForModel(content);
    await this.backend.followUp(contentForModel);
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
    const name = this.getTopicName === undefined ? null : await this.getTopicName(chatId, topicId);
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
   * Switch the model in place. On an initialized backend this delegates to
   * the backend, which updates the session in place — no dispose, no recreate,
   * no history loss. Before init it just records the override (applied on first
   * prompt). Either way `_modelName`/`resolvedModel` track the new model.
   */
  async setModel(modelName: string): Promise<void> {
    const resolved = resolveModel({ ...this.cfg, modelName });
    this._modelName = modelName;
    this.resolvedModel = resolved;
    if (this.backend.isInitialized) {
      await this.backend.setModel(resolved.model, resolved.apiKey);
    }
  }

  /**
   * If the backend is already initialized, applies immediately.
   * Otherwise stores a pending override applied on first prompt().
   * Pass `undefined` to reset to the model's default.
   */
  setThinkingLevel(level: ThinkingLevel | undefined): void {
    if (this.backend.isInitialized) {
      if (level !== undefined) {
        this.backend.setThinkingLevel(level);
      } else {
        // Reset to model default by re-resolving. Pi does not expose a
        // "clear thinking level" API, so we set it back to the default.
        this.backend.setThinkingLevel(this.resolvedModel?.thinkingLevel ?? "medium");
      }
    } else {
      this._thinkingLevel = level;
    }
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
    await this.init();
    if (!this.backend.isInitialized) {
      throw new Error("Failed to initialize backend");
    }
    if (this.isAbortTimedOut) {
      throw new Error("Cannot compact because the previous abort timed out. Try /new or /archive.");
    }
    if (this.backend.isStreaming) {
      throw new Error("Cannot compact while the agent is still streaming. Try /cancel first.");
    }
    return this.backend.compact(customInstructions);
  }

  /**
   * Clean up resources. Awaits any in-flight memory reflection so that a
   * disposing runner does not leave background writes that race with session
   * archive or rebinding.
   */
  async dispose(): Promise<void> {
    try {
      await this.memoryReflector.awaitSettled(this.sessionId);
    } catch (err) {
      log.error("AgentRunner memory reflector await failed during dispose", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.backend.dispose();
    } catch (err) {
      log.error("AgentRunner dispose failed", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
