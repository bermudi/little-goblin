import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { createPiServices, findMostRecentCompatiblePiSession, piAgentDir, type PiServices } from "../pi-host.ts";
import { sessionDir } from "../sessions/paths.ts";
import type { ResolvedModel } from "./models.ts";
import { SkillResolutionError, type ResolvedSkillSet } from "./skills/mod.ts";

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
  /**
   * Authority wrapper supplied by the owning AgentRunner. Pi's default tools
   * are constructed inside this backend, so the runner supplies this supported
   * definition-level seam rather than trying to reach into an AgentSession.
   */
  guardBuiltInTool: (tool: ToolDefinition) => ToolDefinition;
  systemPrompt: string;
  cwd: string;
  /**
   * Frozen resolved skill set from SkillCatalogResolver. The backend passes
   * only the selected skill file paths to pi's DefaultResourceLoader with
   * `noSkills: true`, so no ambient pi discovery occurs (decision 0034).
   */
  resolvedSkills: ResolvedSkillSet;
}

export interface AgentBackend {
  init(args: AgentBackendInitArgs): Promise<void>;
  sendCustomMessage(message: CustomMessageInput, opts?: { deliverAs?: "nextTurn" }): Promise<void>;
  sendUserMessage(content: string | (TextContent | ImageContent)[]): Promise<void>;
  followUp(content: string | (TextContent | ImageContent)[]): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  dispose(): void;
  isStreaming: boolean;
  isInitialized: boolean;
  getActiveToolNames(): string[] | null;
  getSkills(): { skills: { filePath: string }[] } | null;
  getContextUsage(): { tokens: number | null } | null;
}

interface PiAgentBackendDeps {
  createPiServices: (home: string) => Promise<PiServices>;
  createAgentSession: typeof createAgentSession;
  DefaultResourceLoader: typeof DefaultResourceLoader;
  SessionManager: typeof SessionManager;
  findMostRecentCompatiblePiSession: typeof findMostRecentCompatiblePiSession;
  piAgentDir: typeof piAgentDir;
  sessionDir: typeof sessionDir;
}

export interface PiAgentBackendOptions extends AgentBackendOptions {
  deps?: Partial<PiAgentBackendDeps>;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeSkillPath(filePath: string): string {
  return resolve(filePath);
}

async function validateSelectedSkillFiles(skillPaths: readonly string[]): Promise<void> {
  const unavailable: string[] = [];
  for (const skillPath of skillPaths) {
    try {
      const stats = await stat(skillPath);
      if (!stats.isFile()) unavailable.push(`${skillPath} (not a regular file)`);
    } catch (error) {
      if (isEnoent(error)) {
        unavailable.push(`${skillPath} (missing)`);
        continue;
      }
      throw error;
    }
  }

  if (unavailable.length > 0) {
    throw new SkillResolutionError(
      `resolved skill file(s) cannot be loaded before Pi initialization: ${unavailable.join(", ")}`,
    );
  }
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

  constructor(opts: PiAgentBackendOptions) {
    this.cfg = opts.cfg;
    this.sessionId = opts.sessionId;
    this.onEvent = opts.onEvent;
    this.deps = {
      createPiServices,
      createAgentSession,
      DefaultResourceLoader,
      SessionManager,
      findMostRecentCompatiblePiSession,
      piAgentDir,
      sessionDir,
      ...opts.deps,
    };
  }

  async init(args: AgentBackendInitArgs): Promise<void> {
    if (this.session) return;

    const home = this.cfg.goblinHome;
    const { resolvedModel, thinkingLevel, customTools, guardBuiltInTool, systemPrompt, cwd, resolvedSkills } = args;

    const { modelRuntime, settingsManager } = await this.deps.createPiServices(home);
    await modelRuntime.setRuntimeApiKey(resolvedModel.model.provider, resolvedModel.apiKey);

    const agentDir = this.deps.piAgentDir(home);

    const piSessionDir = join(this.deps.sessionDir(home, this.sessionId), "pi");
    const recent = this.deps.findMostRecentCompatiblePiSession(piSessionDir, cwd);
    const sessionManager = recent
      ? this.deps.SessionManager.open(recent, piSessionDir, cwd)
      : this.deps.SessionManager.create(cwd, piSessionDir);

    const selectedSkillPaths = resolvedSkills.skills.map((skill) => skill.filePath);
    await validateSelectedSkillFiles(selectedSkillPaths);

    const resourceLoader = new this.deps.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPrompt,
      noContextFiles: true,
      noSkills: true,
      additionalSkillPaths: selectedSkillPaths,
    });
    await resourceLoader.reload();

    const loadedSkillPaths = new Set(
      resourceLoader.getSkills().skills.map((skill) => normalizeSkillPath(skill.filePath)),
    );
    const notLoaded = selectedSkillPaths.filter(
      (skillPath) => !loadedSkillPaths.has(normalizeSkillPath(skillPath)),
    );
    if (notLoaded.length > 0) {
      throw new SkillResolutionError(
        `resolved skill file(s) failed to load in Pi: ${notLoaded.join(", ")}`,
      );
    }

    // Pi exposes factory functions for the default tool definitions. Build
    // those definitions here and override the SDK defaults through its public
    // `customTools` seam, preserving each factory's schema, prompt metadata,
    // renderer, and implementation. `noTools: "builtin"` disables only the
    // unguarded defaults; same-named custom definitions become the active
    // standard tools.
    const guardedBuiltIns = [
      guardBuiltInTool(defineTool(createReadToolDefinition(cwd))),
      guardBuiltInTool(defineTool(createBashToolDefinition(cwd))),
      guardBuiltInTool(defineTool(createEditToolDefinition(cwd))),
      guardBuiltInTool(defineTool(createWriteToolDefinition(cwd))),
    ];

    const { session } = await this.deps.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      model: resolvedModel.model,
      thinkingLevel,
      noTools: "builtin",
      customTools: [...guardedBuiltIns, ...customTools],
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

  dispose(): void {
    try {
      this.unsubscribe?.();
    } catch (err) {
      log.error("AgentBackend unsubscribe failed", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.unsubscribe = null;
    }
    try {
      this.session?.dispose();
    } catch (err) {
      log.error("AgentBackend session.dispose failed", {
        sessionId: this.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.session = null;
    }
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
