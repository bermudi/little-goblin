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
  EmbeddingProvider,
  createMemorySearchTool,
  createMemoryWriteTool,
  formatRelevantMemory,
  type CapturedMemoryContext,
  type InternalMemoryContext,
} from "../memory/mod.ts";
import { DreamingPipeline } from "../memory/dreaming.ts";
import { MetricsStore, type MetricsUsage, type TurnMetricsEvent } from "../metrics/mod.ts";
import { type GenericSubagentInheritance, type SubagentRunner } from "../subagents/mod.ts";
import { surfaceId, type Surface } from "../surface.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import { createScheduleTurnTool } from "../scheduler/tool.ts";
import { AgentBackend, AgentBackendOptions, PiAgentBackend } from "./backend.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { TranscriptWriterContext } from "../sessions/transcript.ts";
import { createExternalAgentTool } from "../external-agents/tool.ts";
import { McpRunner, createMcpTools } from "../mcp/mod.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { environmentCwd, projectRootOf } from "../sessions/environment.ts";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import {
  cloneSkillPolicy,
  resolveSkillSet,
  DEFAULT_SKILL_POLICY,
  type ResolvedSkillSet,
  type SkillPolicy,
} from "./skills/mod.ts";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "../workspace/paths.ts";

/**
 * Shared fields for all `AgentRunner` construction variants.
 */
interface AgentRunnerOptionsBase {
  cfg: Config;
  sessionId: string;
  customTools: ToolDefinition[];
  subagentRunner?: SubagentRunner;
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  /** Immutable execution environment captured at Conversation creation. */
  executionEnvironment: ExecutionEnvironment;
  /** Session-scoped model override. Falls back to config default when absent. */
  modelName?: string;
  /** Session-scoped thinking level override. Falls back to model default when absent. */
  thinkingLevel?: ThinkingLevel;
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
  /** Optional pre-built memory store (tests may inject one). */
  memoryStore?: MemoryStore;
  /** Shared schedule store. When present, the agent gets the `schedule_turn` tool. */
  scheduleStore?: ScheduleStore;
  /** Shared external agent runner. When present and enabled, the agent gets the `external_agent` tool. */
  externalAgentRunner?: ExternalAgentRunner;
  /** Shared MCP runner. When present and configured, the agent gets the `mcp_call` and `mcp_describe` tools. */
  mcpRunner?: McpRunner;
  /**
   * Skill selection policy for this runtime. Defaults to
   * {@link DEFAULT_SKILL_POLICY} (Goblin all, environment all, host none) when
   * a caller has no Surface-specific policy.
   */
  skillPolicy?: SkillPolicy;
  /** Frozen catalog result captured by orchestration during runtime creation. */
  resolvedSkills?: ResolvedSkillSet;
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

/**
 * Options for constructing a Surface-backed `AgentRunner`. The memory context
 * is a {@link CapturedMemoryContext} and the Telegram {@link Surface} is
 * required — schedule, subagent, and external-agent tools need it for delivery.
 */
export interface SurfaceAgentRunnerOptions extends AgentRunnerOptionsBase {
  memoryContext: CapturedMemoryContext;
  surface: Surface;
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
  surface?: never;
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

// Matches pi's public coding-tool path behavior. pi does not export its
// resolveToCwd helper, so keep this intentionally small compatibility seam
// limited to the normalizations that affect prompt-file notices.
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Normalize a write/edit path exactly as pi's `resolveToCwd` does before this
 * module compares it to a reserved prompt file. This affects notice matching
 * only; it grants no filesystem authority and does not alter tool execution.
 */
function normalizePiToolPath(rawPath: string): string {
  let normalized = rawPath.replace(PI_UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** Resolve a tool `path` using pi-compatible @, file URL, ~, and CWD rules. */
function resolveToolPath(cwd: string, rawPath: string): string {
  let expanded = normalizePiToolPath(rawPath);
  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = resolve(homedir(), expanded.slice(2));
  }
  return resolve(cwd, expanded);
}

/** Summarize a `write` or `edit` tool without including file contents. */
function summarizeToolChange(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    if (content.length === 0) return "wrote empty file";
    const lines = content.split("\n").length;
    return `wrote ${lines} line${lines === 1 ? "" : "s"} (${content.length} chars)`;
  }
  if (toolName === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.length : 0;
    return `${edits} edit${edits === 1 ? "" : "s"}`;
  }
  return "modified";
}

/**
 * AgentRunner wraps a pi AgentSession for a single goblin session.
 * Manages lazy initialization and event dispatch.
 */
export class AgentRunner {
  private cfg: Config;
  private sessionId: string;
  private surface: Surface | undefined;
  private customTools: ToolDefinition[];
  private subagentRunner: SubagentRunner | null;
  private scheduleStore: ScheduleStore | undefined;
  private externalAgentRunner: ExternalAgentRunner | null;
  private mcpRunner: McpRunner | null;
  private isCurrent: () => boolean;
  private backend: AgentBackend;
  private accumulatedText: string = "";
  private callbacks: TurnCallbacks | null = null;
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
  private readonly transcriptWriterContext: TranscriptWriterContext;
  private getTopicName: ((chatId: number, topicId: number) => Promise<string | null>) | undefined;
  private topicNameCache = new Map<string, string | null>();
  private executionEnvironment: ExecutionEnvironment;
  private skillPolicy: SkillPolicy;
  private resolvedSkills: ResolvedSkillSet | null;
  private _modelName: string | undefined;
  private _thinkingLevel: ThinkingLevel | undefined;
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
  /** Args for in-flight tool calls, keyed by pi `toolCallId`. */
  private pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();

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
    this.surface = opts.surface;
    this.memoryContext = opts.memoryContext;
    this.transcriptWriterContext =
      this.memoryContext.kind === "surface"
        ? { kind: "surface", sourceSurfaceId: this.memoryContext.authority.sourceSurfaceId }
        : { kind: "internal" };
    this.customTools = opts.customTools;
    this.subagentRunner = opts.subagentRunner ?? null;
    this.scheduleStore = opts.scheduleStore;
    this.externalAgentRunner = opts.externalAgentRunner ?? null;
    this.mcpRunner = opts.mcpRunner ?? null;
    this.isCurrent = opts.memoryContext.kind === "surface"
      ? (opts as SurfaceAgentRunnerOptions).isCurrent
      : () => true;
    this.getTopicName = opts.getTopicName;
    this.executionEnvironment = opts.executionEnvironment;
    this.skillPolicy = cloneSkillPolicy(opts.skillPolicy ?? DEFAULT_SKILL_POLICY);
    this.resolvedSkills = opts.resolvedSkills ?? null;
    this._modelName = opts.modelName ?? (opts.resolvedModel ? `${opts.resolvedModel.model.provider}/${opts.resolvedModel.model.id}` : undefined);
    this._thinkingLevel = opts.thinkingLevel;
    this.resolvedModel = opts.resolvedModel ?? null;
    this.metricsStore = new MetricsStore(opts.cfg.goblinHome, this.sessionId);
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
      onEvent: (event) => this.handleEvent(event),
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
      const cwd = environmentCwd(this.executionEnvironment, home);
      const resolvedModel = this.resolvedModel ?? resolveModel({ ...this.cfg, modelName: this._modelName ?? this.cfg.modelName });
      this.resolvedModel = resolvedModel;

      const goblinSystemPrompt = await this.awaitCurrent(() => buildGoblinSystemPrompt({
        home,
        executionEnvironment: this.executionEnvironment,
      }));
      this.goblinSystemPrompt = goblinSystemPrompt;

      // Resolve skill catalogs into a frozen set before building tools and
      // backend init. Skills are snapshotted at runtime creation (decision
      // 0034); no ambient pi discovery, no watcher, no per-turn reload. The
      // spawn/revive subagent tools built below inherit this same manifest.
      const resolvedSkills = this.resolvedSkills ?? await this.awaitCurrent(() =>
        resolveSkillSet(this.executionEnvironment, this.skillPolicy, home),
      );
      this.resolvedSkills = resolvedSkills;
      if (resolvedSkills.diagnostics.length > 0) {
        log.debug("Skill catalog diagnostics", {
          sessionId: this.sessionId,
          count: resolvedSkills.diagnostics.length,
        });
      }

      const tools = await this.awaitCurrent(() => this.buildCustomTools());

      let systemPrompt = goblinSystemPrompt.prompt;
      // Consume the completed capture — do not reread the store for the frozen
      // summary or deduplication bodies. The capture was completed before
      // runner registration; post-capture writes cannot alter it.
      if (this.memoryContext.kind === "surface") {
        const frozenSummary = this.memoryContext.frozenSummary;
        if (frozenSummary !== null) {
          systemPrompt = `${systemPrompt}\n\n${frozenSummary}`;
        }
      }

      this.throwIfAbortedBeforeInit();
      await this.awaitCurrent(() => this.backend.init({
        resolvedModel,
        thinkingLevel: this._thinkingLevel ?? resolvedModel.thinkingLevel,
        customTools: tools,
        guardBuiltInTool: (tool) => this.guardTool(tool),
        systemPrompt,
        cwd,
        resolvedSkills,
      }));
      this.throwIfAbortedBeforeInit();
      // Consumed — any later setThinkingLevel() calls go through the live backend.
      this._thinkingLevel = undefined;

      log.debug("AgentRunner initialized", { sessionId: this.sessionId });
    } finally {
      this._initInProgress = false;
    }
  }

  private async buildCustomTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [...this.customTools];

    // Memory tools are registered only for Surface-backed runners. Internal
    // runners (dreaming extraction) use the explicit Surface-free path and
    // receive no ordinary memory tools.
    if (this.memoryContext.kind === "surface") {
      tools.push(
        createMemorySearchTool({
          store: this.memoryStore,
          context: this.memoryContext,
          getTopicName: (chatId, topicId) => this.cachedTopicName(chatId, topicId),
          metrics: this.metricsStore,
        }),
        createMemoryWriteTool({ store: this.memoryStore, context: this.memoryContext }),
      );
    }

    if (this.scheduleStore && this.surface !== undefined) {
      tools.push(
        createScheduleTurnTool({
          store: this.scheduleStore,
          surface: this.surface,
          now: () => Date.now(),
          isCurrent: this.isCurrent,
        }),
      );
    }

    if (this.subagentRunner && this.memoryContext.kind === "surface") {
      const { createSpawnSubagentTool, createReviveSubagentTool } = await import("../subagents/tool.ts");
      // Generic subagents inherit this runtime's immutable environment and
      // frozen manifest. init() resolves the latter before building tools.
      const inheritance = this.genericSubagentInheritance;
      if (inheritance === null) {
        throw new Error("generic subagent inheritance unavailable for subagent tools");
      }
      // Use delegating wrappers so the tools always forward to the current
      // turn's MessageBuffer — callbacks change per-prompt().
      tools.push(
        createSpawnSubagentTool(
          this.subagentRunner,
          0,
          this.sessionId,
          this.memoryContext,
          inheritance,
          (msg) => this.sendStatusUpdate(msg),
          undefined,
        ),
      );
      tools.push(
        createReviveSubagentTool(
          this.subagentRunner,
          this.memoryContext,
          inheritance,
          (msg) => this.sendStatusUpdate(msg),
        ),
      );
    }

    const projectDir = projectRootOf(this.executionEnvironment);
    if (this.externalAgentRunner && this.cfg.externalAgents?.backends.length && projectDir) {
      tools.push(
        createExternalAgentTool({
          runner: this.externalAgentRunner,
          sessionId: this.sessionId,
          projectDir,
          enabledBackends: this.cfg.externalAgents.backends,
          onStatusUpdate: (msg) => this.sendStatusUpdate(msg),
        }),
      );
    }

    if (this.mcpRunner && this.cfg.mcp) {
      await this.awaitCurrent(() => this.mcpRunner!.ready);
      tools.push(...createMcpTools(this.mcpRunner));
    }

    return tools.map((tool) => this.guardTool(tool));
  }

  /**
   * Handle AgentSession events, dispatch to callbacks and log to transcript.
   */
  private handleEvent(event: AgentSessionEvent): void {
    // Pi may emit late events after lifecycle disposal. Drop every stale event
    // before it can write a transcript, metrics, callback, or tool side effect.
    if (!this.isCurrent()) return;

    // Append to transcript (compact message-level log). The writer context was
    // frozen at construction from the completed runtime memory context; the
    // transcript module validates and stamps it.
    appendTranscriptEntry(this.sessionId, this.cfg.goblinHome, event, this.transcriptWriterContext);

    // Update session metrics from backend events. This runs before the
    // callback guard so turn and tool counters are recorded even when no
    // UI callbacks are bound.
    this.updateMetrics(event);

    // Track tool args and surface bounded notices for prompt-file writes.
    // These run before the callback guard so the runner still records and
    // reports tool usage when no UI sink is bound.
    if (event.type === "tool_execution_start") {
      this.trackToolStart(event);
    }
    if (event.type === "tool_execution_end") {
      this.handleToolEnd(event);
    }

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

    // Dreaming light sleep is driven entirely by the scheduler. The cursor is
    // owned by `processSession`, which reads transcript lines after the cursor,
    // extracts candidates, and advances the cursor past what it processed.
    // Advancing the cursor here on `agent_end` would skip past new lines before
    // the scheduled pass could read them, leaving light sleep with nothing to
    // do. followUp() steers a running turn without emitting an independent
    // agent_end. Internal (non-chat) runners skip dreaming entirely.
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

  /** Remember a tool call's arguments so we can inspect them on completion. */
  private trackToolStart(event: AgentSessionEvent): void {
    const e = event as unknown as Record<string, unknown>;
    const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
    const toolName = typeof e.toolName === "string" ? e.toolName : undefined;
    if (toolCallId === undefined || toolName === undefined) return;
    this.pendingToolCalls.set(toolCallId, { toolName, args: e.args });
  }

  /**
   * On a successful `write` or `edit`, resolve the target path and post a
   * bounded notice if it is one of the reserved prompt files. The notice is
   * best-effort and non-blocking; a delivery failure MUST NOT fail the write.
   */
  private handleToolEnd(event: AgentSessionEvent): void {
    const e = event as unknown as Record<string, unknown>;
    const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
    if (toolCallId === undefined) return;

    const pending = this.pendingToolCalls.get(toolCallId);
    this.pendingToolCalls.delete(toolCallId);
    if (pending === undefined) return;
    if (e.isError === true) return;
    if (pending.toolName !== "write" && pending.toolName !== "edit") return;

    const args = pending.args;
    if (typeof args !== "object" || args === null) return;
    const a = args as Record<string, unknown>;
    const rawPath = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined;
    if (rawPath === undefined) return;

    const cwd = environmentCwd(this.executionEnvironment, this.cfg.goblinHome);
    const resolvedPath = resolveToolPath(cwd, rawPath);
    if (!this.isReservedPromptFilePath(resolvedPath)) return;

    const fileName = basename(resolvedPath);
    const summary = summarizeToolChange(pending.toolName, a);
    this.sendNotice(`Modified prompt file \`${fileName}\`: ${summary}`);
  }

  /** Resolve `~` and relative paths the same way pi's file tools do. */
  private isReservedPromptFilePath(resolvedPath: string): boolean {
    const home = this.cfg.goblinHome;
    const reserved = new Set([
      resolve(soulMdPath(home)),
      resolve(agentsMdPath(home)),
      resolve(heartbeatMdPath(home)),
    ]);
    if (this.surface !== undefined) {
      reserved.add(resolve(surfaceHeartbeatPath(home, surfaceId(this.surface))));
    }
    return reserved.has(resolve(resolvedPath));
  }

  /** Deliver a status only while the captured Surface runtime remains current. */
  private sendStatusUpdate(text: string): void {
    if (!this.isCurrent()) return;
    this.callbacks?.onStatusUpdate(text);
  }

  /** Fire-and-forget delivery of a bounded notice to the turn's surface sink. */
  private sendNotice(text: string): void {
    if (!this.isCurrent()) return;
    const send = this.callbacks?.sendNotice;
    if (send === undefined) return;
    send(text).then(
      () => {
        // Delivery has no compensating action, but do not allow callers to
        // continue a stale notice chain after its asynchronous boundary.
        this.assertCurrent();
      },
      (err: unknown) => {
        log.warn("prompt-file notice failed", { error: String(err), sessionId: this.sessionId });
      },
    ).catch(() => {
      // `assertCurrent` intentionally rejects a stale post-delivery result;
      // the lifecycle has already fenced the old runner, so no retry occurs.
    });
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
   */
  async followUp(content: string | (TextContent | ImageContent)[]): Promise<void> {
    this.assertCurrent();
    if (!this.backend.isInitialized) {
      throw new Error("Cannot steer: session not initialized. Call prompt() first.");
    }
    if (!this.isStreaming) {
      throw new Error("Cannot steer: session is not streaming.");
    }
    const contentForModel = this.normalizeContentForModel(content);
    await this.awaitCurrent(() => this.backend.followUp(contentForModel));
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
   * Switch the model in place. On an initialized backend this delegates to
   * the backend, which updates the session in place — no dispose, no recreate,
   * no history loss. Before init it just records the override (applied on first
   * prompt). Either way `_modelName`/`resolvedModel` track the new model.
   */
  async setModel(modelName: string): Promise<void> {
    this.assertCurrent();
    const resolved = resolveModel({ ...this.cfg, modelName });
    this._modelName = modelName;
    this.resolvedModel = resolved;
    if (this.backend.isInitialized) {
      await this.awaitCurrent(() => this.backend.setModel(resolved.model, resolved.apiKey));
    }
  }

  /**
   * If the backend is already initialized, applies immediately.
   * Otherwise stores a pending override applied on first prompt().
   * Pass `undefined` to reset to the model's default.
   */
  setThinkingLevel(level: ThinkingLevel | undefined): void {
    this.assertCurrent();
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
    try {
      await this.dreamingPipeline.awaitSettled(this.sessionId);
    } catch (err) {
      log.error("AgentRunner dreaming pipeline await failed during dispose", {
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
    if (this.ownsMemoryStore) {
      try {
        this.memoryStore.close();
      } catch (err) {
        log.error("AgentRunner memory store close failed", {
          sessionId: this.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
