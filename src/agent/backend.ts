import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { createPiServices, findMostRecentPiSession, piAgentDir, type PiServices } from "../pi-host.ts";
import { skillsPath, workdirPath } from "../workspace/paths.ts";
import { sessionDir } from "../sessions/paths.ts";
import type { ResolvedModel } from "./models.ts";

// We intentionally use structural matches for the payload shapes so callers
// (project notice, memory snapshot) do not need to import pi's internal
// CustomMessage type, which is not exported from the package index.
export interface CustomMessageInput {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export interface AgentBackendOptions {
  cfg: Config;
  sessionId: string;
  onEvent: (event: AgentSessionEvent) => void;
}

export interface AgentBackendInitArgs {
  resolvedModel: ResolvedModel;
  thinkingLevel: ThinkingLevel;
  customTools: ToolDefinition[];
  systemPrompt: string;
  cwd: string;
}

export interface AgentBackend {
  init(args: AgentBackendInitArgs): Promise<void>;
  sendCustomMessage(message: CustomMessageInput, opts?: { deliverAs?: "nextTurn" }): Promise<void>;
  sendUserMessage(content: string | (TextContent | ImageContent)[]): Promise<void>;
  followUp(content: string | (TextContent | ImageContent)[]): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  setModel(model: Model<Api>, apiKey: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  dispose(): void;
  isStreaming: boolean;
  isInitialized: boolean;
  getActiveToolNames(): string[] | null;
  getSkills(): { skills: { filePath: string }[] } | null;
  getContextUsage(): { tokens: number | null } | null;
}

interface PiAgentBackendDeps {
  createPiServices: (home: string) => PiServices;
  createAgentSession: typeof createAgentSession;
  DefaultResourceLoader: typeof DefaultResourceLoader;
  SessionManager: typeof SessionManager;
  findMostRecentPiSession: typeof findMostRecentPiSession;
  piAgentDir: typeof piAgentDir;
  sessionDir: typeof sessionDir;
  workdirPath: typeof workdirPath;
  skillsPath: typeof skillsPath;
}

export interface PiAgentBackendOptions extends AgentBackendOptions {
  deps?: Partial<PiAgentBackendDeps>;
}

/**
 * Concrete backend that wraps the real pi-coding-agent AgentSession.
 *
 * This is the only place in the source tree that imports the pi SDK's
 * `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, etc.
 * Isolating it makes the runner testable against a fake backend and lets
 * contract tests drive the real SDK with deterministic fake providers.
 */
export class PiAgentBackend implements AgentBackend {
  private cfg: Config;
  private sessionId: string;
  private onEvent: (event: AgentSessionEvent) => void;
  private deps: PiAgentBackendDeps;

  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private resourceLoader: DefaultResourceLoader | null = null;
  private authStorage: PiServices["authStorage"] | null = null;

  constructor(opts: PiAgentBackendOptions) {
    this.cfg = opts.cfg;
    this.sessionId = opts.sessionId;
    this.onEvent = opts.onEvent;
    this.deps = {
      createPiServices,
      createAgentSession,
      DefaultResourceLoader,
      SessionManager,
      findMostRecentPiSession,
      piAgentDir,
      sessionDir,
      workdirPath,
      skillsPath,
      ...opts.deps,
    };
  }

  async init(args: AgentBackendInitArgs): Promise<void> {
    if (this.session) return;

    const home = this.cfg.goblinHome;
    const { resolvedModel, thinkingLevel, customTools, systemPrompt, cwd } = args;

    const { authStorage, modelRegistry, settingsManager } = this.deps.createPiServices(home);
    this.authStorage = authStorage;

    authStorage.setRuntimeApiKey(resolvedModel.model.provider, resolvedModel.apiKey);

    const agentDir = this.deps.piAgentDir(home);

    const piSessionDir = join(this.deps.sessionDir(home, this.sessionId), "pi");
    const recent = this.deps.findMostRecentPiSession(piSessionDir);
    const sessionManager = recent
      ? this.deps.SessionManager.open(recent, piSessionDir, cwd)
      : this.deps.SessionManager.create(cwd, piSessionDir);

    const resourceLoader = new this.deps.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPrompt,
      noContextFiles: true,
      additionalSkillPaths: [this.deps.skillsPath(home)],
      ...(this.cfg.skillSources === "goblin-only" ? { noSkills: true } : {}),
    });
    await resourceLoader.reload();

    const { session } = await this.deps.createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      model: resolvedModel.model,
      thinkingLevel,
      customTools,
      resourceLoader,
    });

    this.session = session;
    this.resourceLoader = resourceLoader;
    this.unsubscribe = session.subscribe((event) => {
      this.onEvent(event);
    });
  }

  async sendCustomMessage(message: CustomMessageInput, opts?: { deliverAs?: "nextTurn" }): Promise<void> {
    if (!this.session) throw new Error("Session not initialized");
    await this.session.sendCustomMessage(message, opts);
  }

  async sendUserMessage(content: string | (TextContent | ImageContent)[]): Promise<void> {
    if (!this.session) throw new Error("Session not initialized");
    await this.session.sendUserMessage(content);
  }

  async followUp(content: string | (TextContent | ImageContent)[]): Promise<void> {
    if (!this.session) throw new Error("Session not initialized");
    if (typeof content === "string") {
      await this.session.followUp(content);
      return;
    }
    const texts = content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text);
    const images = content.filter((c): c is ImageContent => c.type === "image");
    await this.session.followUp(texts.join("\n"), images.length > 0 ? images : undefined);
  }

  async abort(): Promise<void> {
    if (!this.session) return;
    await this.session.abort();
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    if (!this.session) throw new Error("Session not initialized");
    return this.session.compact(customInstructions);
  }

  async setModel(model: Model<Api>, apiKey: string): Promise<void> {
    if (!this.session) return;
    this.authStorage?.setRuntimeApiKey(model.provider, apiKey);
    await this.session.setModel(model);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    if (!this.session) return;
    this.session.setThinkingLevel(level);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
  }

  get isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  get isInitialized(): boolean {
    return this.session !== null;
  }

  getActiveToolNames(): string[] | null {
    return this.session?.getActiveToolNames() ?? null;
  }

  getSkills(): { skills: { filePath: string }[] } | null {
    return this.resourceLoader?.getSkills() ?? null;
  }

  getContextUsage(): { tokens: number | null } | null {
    return this.session?.getContextUsage() ?? null;
  }
}
