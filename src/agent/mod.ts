import { join } from "node:path";

/**
 * Agent runner module.
 * Orchestrates LLM calls, tool use, and turn management.
 */

import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { appendEvent, appendTranscriptEntry, dispatchAgentEvent } from "./events.ts";
import type { TurnCallbacks } from "./events.ts";
export type { TurnCallbacks } from "./events.ts";
import { workdirPath, createPiServices, piAgentDir } from "../pi-host.ts";
import { resolveModel, type ResolvedModel } from "./models.ts";
import {
  MemoryStore,
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemoryWriteTool,
  formatSnapshot,
  resolveActiveScope,
} from "../memory/mod.ts";
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
  private activeScope: ActiveScope;
  private getTopicName: ((chatId: number, topicId: number) => Promise<string | null>) | undefined;
  private topicNameCache = new Map<string, string | null>();
  private projectDir: string | undefined;
  private _modelName: string | undefined;
  private resolvedModel: ResolvedModel | null = null;
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
    // Construction is cheap (no I/O); the directory is created lazily on first write.
    this.memoryStore = new MemoryStore(opts.cfg.goblinHome);
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
    authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);

    const cwd = this.projectDir ?? workdirPath(home);
    const agentDir = piAgentDir(home);

    const sessionManager = SessionManager.inMemory(cwd);

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

    const resourceLoader =
      this.cfg.skillSources === "auto"
        ? undefined
        : new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            additionalSkillPaths: [join(home, "skills")],
            ...(this.cfg.skillSources === "goblin-only" ? { noSkills: true } : {}),
          });
    await resourceLoader?.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      model: resolved.model,
      customTools: tools,
      ...(resourceLoader === undefined ? {} : { resourceLoader }),
    });

    this.session = session;

    // Subscribe to events
    this.unsubscribe = session.subscribe((event) => {
      this.handleEvent(event);
    });

    log.debug("AgentRunner initialized", { sessionId: this.sessionId });
  }

  /**
   * Handle AgentSession events, dispatch to callbacks and log to events.jsonl.
   */
  private handleEvent(event: AgentSessionEvent): void {
    // Append every event to events.jsonl
    appendEvent(this.sessionId, this.cfg.goblinHome, event);
    appendTranscriptEntry(this.sessionId, this.cfg.goblinHome, event);

    if (!this.callbacks) return;

    // AgentRunner-specific text accumulation (not part of dispatch)
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        this.accumulatedText += ame.delta;
      }
    }

    dispatchAgentEvent(event, this.callbacks);
  }

  /**
   * Send a prompt to the agent. Accepts plain text or multimodal content
   * blocks (text + images). Creates the session lazily on first call.
   */
  async prompt(
    content: string | (TextContent | ImageContent)[],
    callbacks: TurnCallbacks,
  ): Promise<void> {
    await this.init();
    if (!this.session) {
      throw new Error("Failed to initialize AgentSession");
    }

    this.callbacks = callbacks;
    this.accumulatedText = "";

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

    if (this.session.isStreaming) {
      // followUp API is (text, images?). Unpack content blocks for it.
      if (typeof contentForModel === "string") {
        await this.session.followUp(contentForModel);
      } else {
        const texts = contentForModel
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text);
        const images = contentForModel.filter((c): c is ImageContent => c.type === "image");
        await this.session.followUp(texts.join("\n"), images.length > 0 ? images : undefined);
      }
    } else {
      await this.session.sendUserMessage(contentForModel);
    }
  }

  private normalizeContentForModel(
    content: string | (TextContent | ImageContent)[],
  ): string | (TextContent | ImageContent)[] {
    if (typeof content === "string") return content;

    const model = this.resolvedModel?.model;
    if (model?.provider !== "poe" || model.api !== "openai-completions") return content;

    const hasImage = content.some((part) => part.type === "image");
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
   * Configured model id (session override or config default).
   * Available even before the session has been initialized.
   */
  get modelName(): string {
    return this._modelName ?? this.cfg.modelName;
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
