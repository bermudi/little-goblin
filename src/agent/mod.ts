/**
 * Agent runner module.
 * Orchestrates LLM calls, tool use, and turn management.
 */

import {
  AgentSession,
  SessionManager,
  createAgentSession,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { appendEvent, dispatchAgentEvent } from "./events.ts";
import type { TurnCallbacks } from "./events.ts";
export type { TurnCallbacks } from "./events.ts";
import { workdirPath, createPiServices } from "../pi-host.ts";
import { resolveModel } from "./models.ts";
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
    const resolved = resolveModel(this.cfg);

    // Create pi services with goblin paths
    const { authStorage, modelRegistry, settingsManager } = createPiServices(home);
    authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);

    const sessionManager = SessionManager.inMemory(workdirPath(home));

    // Caller-supplied tools first; then memory; then spawn_subagent if wired.
    const tools: ToolDefinition[] = [
      ...this.customTools,
      createMemoryReadTool({ store: this.memoryStore, activeScope: this.activeScope }),
      createMemoryReadIndexTool({
        store: this.memoryStore,
        activeChatId: this.activeScope.chatId,
        includeAgents: true,
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
          (msg) => this.callbacks?.onStatusUpdate(msg),
          undefined,
          this.activeScope,
        ),
      );
      tools.push(
        createReviveSubagentTool(
          this.subagentRunner,
          (msg) => this.callbacks?.onStatusUpdate(msg),
        ),
      );
    }

    const { session } = await createAgentSession({
      cwd: workdirPath(home),
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      model: resolved.model,
      customTools: tools,
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
   * Send a prompt to the agent.
   * Creates the session lazily on first call.
   */
  async prompt(text: string, callbacks: TurnCallbacks): Promise<void> {
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

    if (this.session.isStreaming) {
      await this.session.followUp(text);
    } else {
      await this.session.sendUserMessage(text);
    }
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
   * Configured model id (passed at construction time via `Config.modelName`).
   * Available even before the session has been initialized.
   */
  get modelName(): string {
    return this.cfg.modelName;
  }

  /**
   * Abort the current agent operation.
   */
  async abort(): Promise<void> {
    if (this._abortTimedOut) return;
    if (!this.session) return;
    await this.session.abort();
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
