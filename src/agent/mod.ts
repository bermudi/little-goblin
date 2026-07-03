import { join } from "node:path";

/**
 * Agent runner module.
 * Orchestrates LLM calls, tool use, and turn management.
 */

import {
  AgentSession,
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { appendTranscriptEntry, dispatchAgentEvent, extractAssistantText } from "./events.ts";
import type { TurnCallbacks } from "./events.ts";
export type { TurnCallbacks } from "./events.ts";
import { workdirPath, createPiServices, piAgentDir, findMostRecentPiSession } from "../pi-host.ts";
import { sessionDir } from "../sessions/paths.ts";
import { resolveModel, type ResolvedModel } from "./models.ts";
import { buildGoblinSystemPrompt } from "./system-prompt.ts";
import {
  MemoryStore,
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemoryWriteTool,
  formatSnapshot,
  resolveActiveScope,
} from "../memory/mod.ts";
import { MemoryReflector } from "../memory/reflector.ts";
import { type SubagentRunner } from "../subagents/mod.ts";
import type { ChatLocator } from "../sessions/types.ts";
import type { ActiveScope } from "../memory/mod.ts";

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
 * AgentRunner wraps a pi AgentSession for a single goblin session.
 * Manages lazy initialization and event dispatch.
 */
export class AgentRunner {
  private cfg: Config;
  private sessionId: string;
  private customTools: ToolDefinition[];
  private subagentRunner: SubagentRunner | null;
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
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
  /** Pi auth storage — retained so setModel() can register a new provider's key. */
  private authStorage: AuthStorage | null = null;
  /**
   * Sticky flag set by the interrupt layer when a prior `abort()` did not
   * resolve within the cascade timeout. Once set, `isStreaming` reports
   * false and `abort()` is a no-op — we've already given up on the
   * in-flight abort, so a second call (from another cancel-capable
   * command) would just hit pi's abort path again on a session in an
   * undefined state.
   */
  private _abortTimedOut: boolean = false;

  constructor(opts: AgentRunnerOptions) {
    this.cfg = opts.cfg;
    this.sessionId = opts.sessionId;
    this.activeScope = resolveActiveScope(opts.locator);
    this.customTools = opts.customTools;
    this.subagentRunner = opts.subagentRunner ?? null;
    this.getTopicName = opts.getTopicName;
    this.projectDir = opts.projectDir;
    this._modelName = opts.modelName;
    this._thinkingLevel = opts.thinkingLevel;
    this.pendingProjectNotice = opts.pendingProjectNotice;
    // Construction is cheap (no I/O); the directory is created lazily on first write.
    this.memoryStore = new MemoryStore(opts.cfg.goblinHome);
    this.memoryReflector = opts.memoryReflector ??
      new MemoryReflector({ goblinHome: opts.cfg.goblinHome, store: this.memoryStore });
  }

  /**
   * Lazy initialization of the AgentSession.
   * Called on first prompt().
   */
  private async init(): Promise<void> {
    if (this.session) return;

    const home = this.cfg.goblinHome;
    const resolved = resolveModel({ ...this.cfg, modelName: this._modelName ?? this.cfg.modelName });
    this.resolvedModel = resolved;

    // Create pi services with goblin paths
    const { authStorage, modelRegistry, settingsManager } = createPiServices(home);
    this.authStorage = authStorage;
    authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);

    const cwd = this.projectDir ?? workdirPath(home);
    const agentDir = piAgentDir(home);

    // Resume the most recent pi session file in this goblin session's private
    // directory. We deliberately do NOT use SessionManager.continueRecent(),
    // which filters candidate files by their on-disk `header.cwd` matching the
    // resolved cwd. Goblin pins the session directory to sessions/<id>/pi (the
    // dir is the scope), and `cwd` here can differ from a prior session file's
    // header — e.g. after a /project bind (the old runner was created under a
    // different cwd) or a /model switch (the recreated runner inherits the
    // current projectDir). With cwd-gated filtering, resume silently misses and
    // a fresh empty session is created, losing all conversation history.
    // Opening the file directly with a cwd override lets history survive across
    // project and model switches.
    const piSessionDir = join(sessionDir(home, this.sessionId), "pi");
    const recent = findMostRecentPiSession(piSessionDir);
    const sessionManager = recent
      ? SessionManager.open(recent, piSessionDir, cwd)
      : SessionManager.create(cwd, piSessionDir);

    // Caller-supplied tools first; then memory; then spawn_subagent if wired.
    const tools: ToolDefinition[] = [
      ...this.customTools,
      createMemoryReadTool({ store: this.memoryStore, activeScope: this.activeScope }),
      createMemoryReadIndexTool({
        store: this.memoryStore,
        activeScope: this.activeScope,
        includeAgents: true,
        getTopicName: (chatId, topicId) => this.cachedTopicName(chatId, topicId),
      }),
      createMemoryWriteTool({ store: this.memoryStore, activeScope: this.activeScope }),
    ];

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

    const systemPrompt = await buildGoblinSystemPrompt({ home, projectDir: this.projectDir });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPrompt,
      noContextFiles: true,
      additionalSkillPaths: [join(home, "skills")],
      ...(this.cfg.skillSources === "goblin-only" ? { noSkills: true } : {}),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      model: resolved.model,
      thinkingLevel: this._thinkingLevel ?? resolved.thinkingLevel,
      customTools: tools,
      resourceLoader,
    });
    // Consumed — any later setThinkingLevel() calls go through the live session.
    this._thinkingLevel = undefined;

    this.session = session;

    // Subscribe to events
    this.unsubscribe = session.subscribe((event) => {
      this.handleEvent(event);
    });

    // Inject any queued project notice as a nextTurn custom message,
    // so the model knows the cwd changed when it sees the next user message.
    if (this.pendingProjectNotice) {
      await session.sendCustomMessage(
        { customType: "project_notice", content: this.pendingProjectNotice, display: false, details: undefined },
        { deliverAs: "nextTurn" },
      );
      this.pendingProjectNotice = undefined;
    }

    log.debug("AgentRunner initialized", { sessionId: this.sessionId });
  }

  /**
   * Handle AgentSession events, dispatch to callbacks and log to transcript.
   */
  private handleEvent(event: AgentSessionEvent): void {
    // Append to transcript (compact message-level log)
    appendTranscriptEntry(this.sessionId, this.cfg.goblinHome, event);

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
    await this.init();
    if (!this.session) {
      throw new Error("Failed to initialize AgentSession");
    }
    if (this.isStreaming) {
      throw new Error("Cannot prompt while streaming; use followUp().");
    }

    this.callbacks = callbacks;
    this.accumulatedText = "";

    // Apply any pending thinking-level override before the turn starts.
    if (this._thinkingLevel !== undefined && this.session) {
      this.session.setThinkingLevel(this._thinkingLevel);
      this._thinkingLevel = undefined;
    }

    // Inject the curated memory snapshot as a per-turn aside.
    // Pi queues it and flushes alongside the next user message; the system
    // prompt stays frozen, preserving the provider prefix cache.
    const aside = await formatSnapshot({
      store: this.memoryStore,
      activeScope: this.activeScope,
      includeAgents: true,
      getTopicName: (chatId, topicId) => this.cachedTopicName(chatId, topicId),
    });
    if (aside !== null) {
      await this.session.sendCustomMessage(aside, { deliverAs: "nextTurn" });
    }

    const contentForModel = this.normalizeContentForModel(content);
    await this.session.sendUserMessage(contentForModel);
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
    if (!this.session) {
      throw new Error("Cannot steer: session not initialized. Call prompt() first.");
    }
    if (!this.isStreaming) {
      throw new Error("Cannot steer: session is not streaming.");
    }
    const contentForModel = this.normalizeContentForModel(content);
    if (typeof contentForModel === "string") {
      await this.session.followUp(contentForModel);
    } else {
      const texts = contentForModel
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text);
      const images = contentForModel.filter((c): c is ImageContent => c.type === "image");
      await this.session.followUp(texts.join("\n"), images.length > 0 ? images : undefined);
    }
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
   * True when the underlying pi `AgentSession` is mid-stream.
   * False when no session has been initialized yet.
   */
  get isStreaming(): boolean {
    if (this._abortTimedOut) return false;
    return this.session?.isStreaming ?? false;
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
   * Names of tools currently active on the underlying pi `AgentSession`.
   * Returns `null` when the session has not been initialized yet (i.e. no
   * `prompt()` has run); callers should render that as "unavailable".
   */
  getActiveToolNames(): string[] | null {
    return this.session?.getActiveToolNames() ?? null;
  }

  /**
   * Number of skills loaded by the resource loader.
   * Returns `null` when the session has not been initialized yet.
   */
  get skillsLoaded(): number | null {
    return this.session?.resourceLoader.getSkills().skills.length ?? null;
  }

  /**
   * Approximate context tokens used. Returns `null` when the session has
   * not been initialized or when the token count is unknown (e.g. right
   * after compaction).
   */
  get contextTokens(): number | null {
    return this.session?.getContextUsage()?.tokens ?? null;
  }

  /**
   * Paths of context files (AGENTS.md, skills) loaded into the session.
   * Returns `null` when the session has not been initialized yet.
   */
  get contextFiles(): string[] | null {
    const s = this.session;
    if (!s) return null;
    const agentsFiles = s.resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path);
    const skillPaths = s.resourceLoader.getSkills().skills.map((sk) => sk.filePath);
    return [...agentsFiles, ...skillPaths];
  }

  /**
   * Configured model id (session override or config default).
   * Available even before the session has been initialized.
   */
  get modelName(): string {
    return this._modelName ?? this.cfg.modelName;
  }

  /**
   * Switch the model in place. On an initialized session this delegates to
   * pi's `session.setModel()`, which appends a `model_change` entry to the
   * *same* session file and re-clamps thinking — no dispose, no recreate, no
   * history loss. Before init it just records the override (applied on first
   * prompt). Either way `_modelName`/`resolvedModel` track the new model.
   */
  async setModel(modelName: string): Promise<void> {
    const resolved = resolveModel({ ...this.cfg, modelName });
    this._modelName = modelName;
    this.resolvedModel = resolved;
    if (this.session) {
      // Register the new provider's API key so session.setModel()'s
      // hasConfiguredAuth check passes for a provider we haven't used yet.
      this.authStorage?.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);
      await this.session.setModel(resolved.model);
    }
  }

  /**
   * If the session is already initialized, applies immediately.
   * Otherwise stores a pending override applied on first prompt().
   * Pass `undefined` to reset to the model's default.
   */
  setThinkingLevel(level: ThinkingLevel | undefined): void {
    if (this.session) {
      if (level !== undefined) {
        this.session.setThinkingLevel(level);
      } else {
        // Reset to model default by re-resolving. Pi does not expose a
        // "clear thinking level" API, so we set it back to the default.
        this.session.setThinkingLevel(this.resolvedModel?.thinkingLevel ?? "medium");
      }
    } else {
      this._thinkingLevel = level;
    }
  }

  /**
   * Abort the current agent operation.
   */
  async abort(): Promise<void> {
    if (this._abortTimedOut) return;
    if (!this.session) return;
    await this.session.abort();
  }

  async compact(customInstructions?: string): Promise<Awaited<ReturnType<AgentSession["compact"]>>> {
    await this.init();
    if (!this.session) {
      throw new Error("Failed to initialize AgentSession");
    }
    if (this._abortTimedOut) {
      throw new Error("Cannot compact because the previous abort timed out. Try /new or /archive.");
    }
    if (this.session.isStreaming) {
      throw new Error("Cannot compact while the agent is still streaming. Try /cancel first.");
    }
    return this.session.compact(customInstructions);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }
}
