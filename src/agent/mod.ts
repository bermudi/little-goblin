/**
 * Agent runner module.
 * Orchestrates LLM calls, tool use, and turn management.
 */

import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { appendEvent } from "./events.ts";
import { agentsMdPath, piAgentDir, workdirPath } from "./paths.ts";
import { resolveModel } from "./models.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, createMemoryTool, formatSnapshot } from "../memory/mod.ts";

/** Callbacks for turn events */
export interface TurnCallbacks {
  onTextDelta: (text: string) => void;
  onToolStart: (name: string, input: unknown) => void;
  onToolEnd: (name: string, isError: boolean) => void;
  onStatusUpdate: (message: string) => void;
  onAgentEnd: () => void;
}

/**
 * AgentRunner wraps a pi AgentSession for a single goblin session.
 * Manages lazy initialization and event dispatch.
 */
export class AgentRunner {
  private cfg: Config;
  private sessionId: string;
  private customTools: ToolDefinition[];
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private accumulatedText: string = "";
  private callbacks: TurnCallbacks | null = null;
  private memoryStore: MemoryStore;

  constructor(cfg: Config, sessionId: string, customTools: ToolDefinition[]) {
    this.cfg = cfg;
    this.sessionId = sessionId;
    this.customTools = customTools;
    // Construction is cheap (no I/O); the directory is created lazily on first write.
    this.memoryStore = new MemoryStore(cfg.goblinHome);
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
    const authStorage = AuthStorage.create(join(piAgentDir(home), "auth.json"));
    // Set the API key as a runtime override
    authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);

    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(piAgentDir(home), "models.json")
    );

    const settingsManager = SettingsManager.inMemory({});
    const sessionManager = SessionManager.inMemory(workdirPath(home));

    // Read AGENTS.md for system prompt augmentation
    // Note: AGENTS.md content would need to be prepended to system prompt.
    // This is handled via pi's resource loader when DefaultResourceLoader is used.
    // For now, we proceed without custom system prompt modification.
    try {
      readFileSync(agentsMdPath(home), "utf-8");
      // Content available but system prompt modification requires pi resource loader integration
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        log.warn("AGENTS.md not found, proceeding without custom system prompt");
      } else {
        throw e;
      }
    }

    // Caller-supplied tools first; the memory tool is appended.
    const tools: ToolDefinition[] = [
      ...this.customTools,
      createMemoryTool(this.memoryStore),
    ];

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

    switch (event.type) {
      case "agent_start":
        this.callbacks.onStatusUpdate("thinking...");
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          this.accumulatedText += ame.delta;
          this.callbacks.onTextDelta(ame.delta);
        }
        break;
      }

      case "agent_end":
        this.callbacks.onAgentEnd();
        break;

      case "tool_execution_start":
        this.callbacks.onToolStart(event.toolName, event.args);
        break;

      case "tool_execution_end":
        this.callbacks.onToolEnd(event.toolName, event.isError === true);
        break;

      // Ignore other event types for now
    }
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
    const aside = formatSnapshot(this.memoryStore);
    if (aside !== null) {
      await this.session.sendCustomMessage(aside, { deliverAs: "nextTurn" });
    }

    if (this.session.isStreaming) {
      await this.session.followUp(text);
    } else {
      await this.session.sendUserMessage(text);
    }
  }

  /**
   * Abort the current agent operation.
   */
  async abort(): Promise<void> {
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

