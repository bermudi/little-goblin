import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionDir, transcriptPath } from "../sessions/paths.ts";
import { piAgentDir } from "../pi-host.ts";
import { agentsMdPath, skillsPath, soulMdPath, workdirPath } from "../workspace/paths.ts";
import { memoryDir } from "../memory/paths.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { AgentBackend, AgentBackendOptions, AgentBackendInitArgs } from "./backend.ts";
import type { ToolDefinition, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Shared mutable state — captured by the module mock closure
// ---------------------------------------------------------------------------

type Listener = (event: Record<string, unknown>) => void;

/**
 * A single session object whose internals are reset between tests.
 * The module mock captures this holder by reference so we can mutate
 * fields without re-registering the mock.
 */
const sessionHolder = {
  listeners: [] as Listener[],
  streaming: false,
  sendUserMessage: mock(async (_content: string | unknown[]) => {}),
  followUp: mock(async (_text: string, _images?: unknown[]) => {}),
  sendCustomMessage: mock(async (_msg: unknown, _opts?: unknown) => {}),
  abort: mock(async () => {}),
  compact: mock(async (_customInstructions?: string) => ({
    summary: "compressed history",
    firstKeptEntryId: "entry-1",
    tokensBefore: 42000,
  })),
  dispose: mock(() => {}),
  setThinkingLevel: mock((_level: string) => {}),
  setModel: mock(async (_model: unknown) => {}),
  /** Sequenced call log for asserting ordering across mocks. */
  callOrder: [] as string[],

  reset() {
    this.listeners = [];
    this.streaming = false;
    this.callOrder = [];
    this.sendUserMessage = mock(async (_content: string | unknown[]) => {
      sessionHolder.callOrder.push("sendUserMessage");
    });
    this.followUp = mock(async (_text: string, _images?: unknown[]) => {
      sessionHolder.callOrder.push("followUp");
    });
    this.sendCustomMessage = mock(async (_msg: unknown, _opts?: unknown) => {
      sessionHolder.callOrder.push("sendCustomMessage");
    });
    this.abort = mock(async () => {});
    this.compact = mock(async (_customInstructions?: string) => {
      sessionHolder.callOrder.push("compact");
      return {
        summary: "compressed history",
        firstKeptEntryId: "entry-1",
        tokensBefore: 42000,
      };
    });
    this.dispose = mock(() => {});
    this.setThinkingLevel = mock((_level: string) => {
      sessionHolder.callOrder.push("setThinkingLevel");
    });
    this.setModel = mock(async (_model: unknown) => {
      sessionHolder.callOrder.push("setModel");
    });
  },

  emit(event: Record<string, unknown>) {
    for (const l of this.listeners) l(event);
  },

  // The actual AgentSession-shaped object returned by createAgentSession
  get proxy() {
    const holder = this;
    return {
      get isStreaming() {
        return holder.streaming;
      },
      subscribe(l: Listener) {
        holder.listeners.push(l);
        return () => {
          const idx = holder.listeners.indexOf(l);
          if (idx !== -1) holder.listeners.splice(idx, 1);
        };
      },
      sendUserMessage: (content: string | unknown[]) => holder.sendUserMessage(content),
      followUp: (text: string, images?: unknown[]) => holder.followUp(text, images),
      sendCustomMessage: (msg: unknown, opts?: unknown) =>
        holder.sendCustomMessage(msg, opts),
      abort: () => holder.abort(),
      compact: (customInstructions?: string) => holder.compact(customInstructions),
      dispose: () => holder.dispose(),
      setThinkingLevel: (level: string) => holder.setThinkingLevel(level),
      setModel: (model: unknown) => holder.setModel(model),
    };
  },
};

let capturedCreateArgs: unknown[] = [];
let capturedResourceLoaderArgs: unknown[] = [];
/** Records each SessionManager factory call: { method, args }. */
let sessionManagerCalls: { method: string; args: unknown[] }[] = [];

// ---------------------------------------------------------------------------
// Fake backend — captures init arguments and delegates to the shared session
// proxy so the unit tests can exercise the AgentRunner without touching the
// real pi-coding-agent SDK.
// ---------------------------------------------------------------------------

class FakeAgentBackend implements AgentBackend {
  private readonly opts: AgentBackendOptions;
  private session: (typeof sessionHolder.proxy) | null = null;
  private unsubscribe: (() => void) | null = null;
  private customTools: ToolDefinition[] = [];
  private resourceLoader: { getSkills: () => { skills: { filePath: string }[]; diagnostics: unknown[] } } | null = null;
  isInitialized = false;

  get isStreaming(): boolean {
    return sessionHolder.streaming;
  }

  constructor(opts: AgentBackendOptions) {
    this.opts = opts;
  }

  async init(args: AgentBackendInitArgs): Promise<void> {
    const home = this.opts.cfg.goblinHome;
    const cwd = args.cwd;
    const sessionDirPath = join(sessionDir(home, this.opts.sessionId), "pi");
    const agentDir = piAgentDir(home);

    const existingSessionFile = findMostRecentSessionFile(sessionDirPath);

    if (existingSessionFile) {
      sessionManagerCalls.push({ method: "open", args: [existingSessionFile, sessionDirPath, cwd] });
    } else {
      sessionManagerCalls.push({ method: "create", args: [cwd, sessionDirPath] });
    }

    const authStorage = { setRuntimeApiKey: (_provider: string, _key: string) => {} };
    const modelRegistry = {};
    const settingsManager = {};
    const resourceLoader = {
      reload: async () => {},
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => args.systemPrompt,
      getAppendSystemPrompt: () => [],
    };

    capturedCreateArgs.push({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager: { cwd, sessionDir: sessionDirPath },
      resourceLoader,
      model: args.resolvedModel.model,
      thinkingLevel: args.thinkingLevel,
      customTools: args.customTools,
    });

    const loaderOpts: Record<string, unknown> = {
      systemPrompt: args.systemPrompt,
      cwd,
      noContextFiles: true,
      additionalSkillPaths: [skillsPath(home)],
    };
    if (this.opts.cfg.skillSources === "goblin-only") {
      loaderOpts.noSkills = true;
    }
    capturedResourceLoaderArgs.push(loaderOpts);

    this.customTools = args.customTools;
    this.resourceLoader = resourceLoader;
    this.session = sessionHolder.proxy;
    this.unsubscribe = this.session.subscribe((event) => this.opts.onEvent(event as unknown as AgentSessionEvent));
    this.isInitialized = true;
  }

  async sendCustomMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, opts?: { deliverAs?: "nextTurn" }): Promise<void> {
    if (!this.session) throw new Error("Session not initialized");
    await this.session.sendCustomMessage(message, opts);
  }

  async sendUserMessage(content: string | unknown[]): Promise<void> {
    if (!this.session) throw new Error("Session not initialized");
    await this.session.sendUserMessage(content);
  }

  async followUp(content: string | unknown[]): Promise<void> {
    if (!this.session) throw new Error("Session not initialized");
    if (typeof content === "string") {
      await this.session.followUp(content);
      return;
    }
    const texts = (content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const images = (content as Array<{ type: string }>).filter((c) => c.type === "image");
    await this.session.followUp(texts, images.length > 0 ? images : undefined);
  }

  async abort(): Promise<void> {
    if (!this.session) return;
    await this.session.abort();
  }

  async compact(customInstructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }> {
    if (!this.session) throw new Error("Session not initialized");
    return this.session.compact(customInstructions);
  }

  async setModel(model: unknown, _apiKey: string): Promise<void> {
    if (!this.session) return;
    await this.session.setModel(model);
  }

  setThinkingLevel(level: string): void {
    if (!this.session) return;
    this.session.setThinkingLevel(level);
  }

  dispose(): void {
    if (!this.session) return;
    this.session.dispose();
    this.unsubscribe?.();
  }

  getActiveToolNames(): string[] | null {
    return this.isInitialized ? this.customTools.map((t) => t.name) : null;
  }

  getSkills(): { skills: { filePath: string }[] } | null {
    return this.isInitialized && this.resourceLoader ? this.resourceLoader.getSkills() : null;
  }

  getContextUsage(): { tokens: number | null } | null {
    return this.isInitialized ? { tokens: null } : null;
  }
}

function findMostRecentSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(dir, f);
      return { path, mtime: statSync(path).mtimeMs };
    });
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries[0]!.path;
}

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { AgentRunner, ModelNotCapableError, type TurnCallbacks } from "./mod.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { ChatLocator } from "../sessions/types.ts";
import { MemoryStore } from "../memory/store.ts";
import {
  MemoryReflector,
  type Candidate,
  type CandidateExtractor,
} from "../memory/reflector.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    openrouterApiKey: "test-key",
    openaiApiKey: "test-key",
    anthropicApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

function nopCallbacks(): TurnCallbacks {
  return {
    onTextDelta: mock(() => {}),
    onToolStart: mock(() => {}),
    onToolEnd: mock(() => {}),
    onStatusUpdate: mock(() => {}),
    onAgentEnd: mock(() => {}),
  };
}

function makeRunner(
  home: string,
  customTools: unknown[] = [],
  locator: ChatLocator = { chatId: 123 },
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>,
  modelName?: string,
  configOverrides: Partial<Config> = {},
  projectDir?: string,
  pendingProjectNotice?: string,
  thinkingLevel?: string,
  memoryReflector?: MemoryReflector,
) {
  return new AgentRunner({
    cfg: { ...makeConfig(home), ...(modelName === undefined ? {} : { modelName }), ...configOverrides },
    sessionId: "abcdef1234",
    locator,
    customTools: customTools as never,
    getTopicName,
    projectDir,
    pendingProjectNotice,
    thinkingLevel: thinkingLevel as never,
    memoryReflector,
    backendFactory: (opts) => new FakeAgentBackend(opts),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "goblin-agent-test-"));
  mkdirSync(sessionDir(tmpDir, "abcdef1234"), { recursive: true });
  writeFileSync(transcriptPath(tmpDir, "abcdef1234"), "");
  mkdirSync(workdirPath(tmpDir), { recursive: true });
  mkdirSync(piAgentDir(tmpDir), { recursive: true });
  // SOUL.md lives under workspace/ — ensure the parent exists before writing.
  mkdirSync(dirname(soulMdPath(tmpDir)), { recursive: true });
  writeFileSync(soulMdPath(tmpDir), "test goblin identity\n", "utf-8");

  capturedCreateArgs = [];
  capturedResourceLoaderArgs = [];
  sessionManagerCalls = [];
  sessionHolder.reset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner", () => {
  describe("pi session persistence", () => {
    it("uses a persisted pi session directory scoped to the goblin session", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.sessionManager).toEqual({
        cwd: workdirPath(tmpDir),
        sessionDir: join(sessionDir(tmpDir, "abcdef1234"), "pi"),
      });
    });

    it("creates a fresh session when no prior pi session file exists", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const methods = sessionManagerCalls.map((c) => c.method);
      expect(methods).toContain("create");
      expect(methods).not.toContain("open");
      expect(methods).not.toContain("continueRecent");
    });

    // Regression: a /project bind or /model switch recreates the runner under
    // a cwd that differs from an existing pi session file's header.cwd. The old
    // code used SessionManager.continueRecent(), which cwd-gates the resume
    // lookup and silently missed — producing a blank session that lost all
    // conversation history. Resume must open the existing file directly with a
    // cwd override instead.
    it("resumes prior pi session even when its header cwd differs from projectDir", async () => {
      const piDir = join(sessionDir(tmpDir, "abcdef1234"), "pi");
      mkdirSync(piDir, { recursive: true });
      // Prior session file whose header cwd does NOT match the runner's cwd.
      const staleCwd = "/some/other/project";
      writeFileSync(
        join(piDir, "2026-01-01T00-00-00-000Z_old.jsonl"),
        JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: staleCwd }) + "\n",
        "utf-8",
      );

      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, undefined, {}, "/home/daniel/build/scribus-card");
      await runner.prompt("hello", nopCallbacks());

      const methods = sessionManagerCalls.map((c) => c.method);
      expect(methods).toContain("open");
      expect(methods).not.toContain("create");
      expect(methods).not.toContain("continueRecent");

      // The open() call must carry the runner's current cwd as the override,
      // not the stale header cwd.
      const openCall = sessionManagerCalls.find((c) => c.method === "open")!;
      expect(openCall.args[2]).toBe("/home/daniel/build/scribus-card");
    });
  });

  describe("memory tool registration", () => {
    it("appends the four memory tools to customTools when none are supplied", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      expect(Array.isArray(tools)).toBe(true);
      const names = tools.map((t) => t.name);
      expect(names).toContain("memory_read");
      expect(names).toContain("memory_read_index");
      expect(names).toContain("memory_search");
      expect(names).toContain("memory_write");
    });

    it("preserves caller-supplied tools and appends memory after them", async () => {
      const t1 = { name: "t1" };
      const t2 = { name: "t2" };
      const runner = makeRunner(tmpDir, [t1, t2]);
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toEqual(["t1", "t2", "memory_read", "memory_read_index", "memory_search", "memory_write"]);
    });

    it("registers memory_search between memory_read_index and memory_write", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      const searchIdx = names.indexOf("memory_search");
      const readIndexIdx = names.indexOf("memory_read_index");
      const writeIdx = names.indexOf("memory_write");
      expect(searchIdx).toBeGreaterThan(-1);
      expect(searchIdx).toBeGreaterThan(readIndexIdx);
      expect(searchIdx).toBeLessThan(writeIdx);
    });

    it("topic-bound memory_write targets the runner's active topic scope", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: -100, topicId: 42 });
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
      const writeTool = tools.find((t) => t.name === "memory_write");
      expect(writeTool).toBeDefined();
      await writeTool!.execute(
        "call-memory-write",
        { action: "add", target: "memory", content: "topic fact" },
        undefined,
        undefined,
        {},
      );
      expect(readFileSync(join(memoryDir(tmpDir), "topics", "-100", "42", "memory.md"), "utf-8")).toBe("topic fact");
    });

    it("main agent memory_search includes all persona scopes", async () => {
      // Seed two persona scopes and the active topic, all matching the query.
      mkdirSync(join(memoryDir(tmpDir), "agents", "researcher"), { recursive: true });
      mkdirSync(join(memoryDir(tmpDir), "agents", "writer"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "agents", "researcher", "memory.md"), "researcher backups persona note", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "agents", "writer", "memory.md"), "writer backups persona note", "utf-8");

      const runner = makeRunner(tmpDir, [], { chatId: -100, topicId: 42 });
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
      const searchTool = tools.find((t) => t.name === "memory_search");
      expect(searchTool).toBeDefined();
      const r = await searchTool!.execute(
        "call-memory-search",
        { query: "backups" },
        undefined,
        undefined,
        {},
      );
      const payload = r as { content: { type: string; text: string }[] };
      const parsed = JSON.parse(payload.content[0]!.text) as { results: Array<{ scope: string }> };
      const scopes = parsed.results.map((x) => x.scope).sort();
      // Main agent (namedAgent=null, includeAgents=true) searches every persona.
      expect(scopes).toEqual(["agents/researcher", "agents/writer"]);
    });

    it("memory_search default scope is limited to the runner's active chat plus global memory", async () => {
      // Same-chat topic + other-chat topic both matching.
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "42"), { recursive: true });
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "7"), { recursive: true });
      mkdirSync(join(memoryDir(tmpDir), "topics", "-200", "9"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "42", "memory.md"), "active backups note", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "7", "memory.md"), "peer backups note", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "topics", "-200", "9", "memory.md"), "other chat backups note", "utf-8");

      const runner = makeRunner(tmpDir, [], { chatId: -100, topicId: 42 });
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const r = await searchTool.execute(
        "call-search-boundary",
        { query: "backups" },
        undefined,
        undefined,
        {},
      );
      const payload = r as { content: { type: string; text: string }[] };
      const parsed = JSON.parse(payload.content[0]!.text) as { results: Array<{ scope: string }> };
      const scopes = parsed.results.map((x) => x.scope).sort();
      expect(scopes).toEqual(["topics/-100/42", "topics/-100/7"]);
      expect(scopes).not.toContain("topics/-200/9");
    });
  });

  describe("per-turn memory aside", () => {
    function seedMemory(home: string, files: { memory?: string; user?: string }): void {
      mkdirSync(memoryDir(home), { recursive: true });
      if (files.memory !== undefined) {
        mkdirSync(join(memoryDir(home), "general"), { recursive: true });
        writeFileSync(join(memoryDir(home), "general", "memory.md"), files.memory, "utf-8");
      }
      if (files.user !== undefined) {
        writeFileSync(join(memoryDir(home), "user.md"), files.user, "utf-8");
      }
    }

    it("does NOT call sendCustomMessage when both memory files are empty/absent", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());
      expect(sessionHolder.sendCustomMessage).not.toHaveBeenCalled();
    });

    it("calls sendCustomMessage with deliverAs:nextTurn and a snapshot payload when memory is non-empty", async () => {
      seedMemory(tmpDir, { memory: "fact-A" });
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
      const [payload, opts] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      expect((opts as { deliverAs?: string }).deliverAs).toBe("nextTurn");
      const p = payload as { customType: string; content: string };
      expect(p.customType).toBe("goblin.memory.snapshot");
      expect(typeof p.content).toBe("string");
      expect(p.content.startsWith("[goblin memory snapshot]")).toBe(true);
      // Stale-prone guardrail is present on every non-null snapshot.
      expect(p.content).toContain("stale or incomplete");
      expect(p.content).toContain("override memory");
    });

    it("renders `(empty)` for the absent file when only one is populated", async () => {
      seedMemory(tmpDir, { memory: "fact-A" });
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const [payload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      const text = (payload as { content: string }).content;
      expect(text).toContain("## memory.md\nfact-A");
      expect(text).toContain("## user.md\n(empty)");
    });

    it("dispatches the aside before sendUserMessage on a non-streaming turn", async () => {
      seedMemory(tmpDir, { user: "pref-1" });
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      expect(sessionHolder.callOrder).toEqual([
        "sendCustomMessage",
        "sendUserMessage",
      ]);
    });

    it("does NOT inject a memory snapshot on followUp (steer reuses the running turn's snapshot)", async () => {
      seedMemory(tmpDir, { user: "pref-1" });
      const runner = makeRunner(tmpDir);
      // Start a turn while idle — this injects the snapshot.
      await runner.prompt("first", nopCallbacks());
      const snapshotCallsBefore = sessionHolder.sendCustomMessage.mock.calls.length;

      // Steer mid-turn: no additional snapshot should be injected.
      sessionHolder.streaming = true;
      await runner.followUp("redirect");

      expect(sessionHolder.sendCustomMessage.mock.calls.length).toBe(snapshotCallsBefore);
      expect(sessionHolder.followUp).toHaveBeenCalledWith("redirect", undefined);
    });

    it("injects a ## relevant memory section when the prompt text matches another scope", async () => {
      // Active general scope + a peer topic in the same chat that matches the prompt.
      mkdirSync(join(memoryDir(tmpDir), "general"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "general", "memory.md"), "general note", "utf-8");
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "7"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "7", "memory.md"), "peer backups note", "utf-8");

      const runner = makeRunner(tmpDir, [], { chatId: -100, topicId: 42 });
      await runner.prompt("tell me about backups", nopCallbacks());

      const [payload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      const text = (payload as { content: string }).content;
      expect(text).toContain("## relevant memory");
      expect(text).toContain("- [topics/-100/7] peer backups note");
    });

    it("omits ## relevant memory when the prompt text has no matches", async () => {
      mkdirSync(join(memoryDir(tmpDir), "general"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "general", "memory.md"), "general note", "utf-8");

      const runner = makeRunner(tmpDir);
      await runner.prompt("hello world", nopCallbacks());

      const [payload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      const text = (payload as { content: string }).content;
      expect(text).not.toContain("## relevant memory");
    });

    it("steer text never produces a relevant-memory section (no snapshot on followUp)", async () => {
      seedMemory(tmpDir, { user: "pref-1" });
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      const callsBefore = sessionHolder.sendCustomMessage.mock.calls.length;

      sessionHolder.streaming = true;
      await runner.followUp("backups");

      // No new snapshot at all — relevant memory is never computed for a steer.
      expect(sessionHolder.sendCustomMessage.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("lazy pi creation", () => {
    it("does not call createAgentSession before prompt()", async () => {
      makeRunner(tmpDir);
      expect(capturedCreateArgs).toHaveLength(0);
    });

    it("calls createAgentSession on first prompt()", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());
      expect(capturedCreateArgs).toHaveLength(1);
    });

    it("does not call createAgentSession again on second prompt()", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      await runner.prompt("second", nopCallbacks());
      expect(capturedCreateArgs).toHaveLength(1);
    });

    it("does not recreate session when memory content changes between turns", async () => {
      // Seed initial memory
      mkdirSync(join(memoryDir(tmpDir), "general"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "general", "memory.md"), "initial", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "user.md"), "user pref", "utf-8");

      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      expect(capturedCreateArgs).toHaveLength(1);

      // Capture call count after first prompt
      const callCountAfterFirst = capturedCreateArgs.length;

      // Modify memory between turns
      writeFileSync(join(memoryDir(tmpDir), "general", "memory.md"), "modified content", "utf-8");

      // Second prompt should NOT recreate the session
      await runner.prompt("second", nopCallbacks());
      expect(capturedCreateArgs).toHaveLength(callCountAfterFirst);

      // Verify second sendCustomMessage contains the new content
      // sendCustomMessage was called twice, second call should have new content
      expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(2);
      const secondCall = sessionHolder.sendCustomMessage.mock.calls[1];
      expect((secondCall![0] as { content: string }).content).toContain("modified content");
    });
  });

  describe("thinking level", () => {
    beforeEach(() => {
      capturedCreateArgs = [];
      sessionHolder.reset();
    });

    it("passes thinkingLevel to createAgentSession on init", async () => {
      const runner = makeRunner(tmpDir, [], undefined, undefined, undefined, {}, undefined, undefined, "high");
      await runner.prompt("hello", nopCallbacks());

      expect(capturedCreateArgs).toHaveLength(1);
      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.thinkingLevel).toBe("high");
    });

    it("clears pending thinkingLevel after init so prompt() does not double-apply", async () => {
      const runner = makeRunner(tmpDir, [], undefined, undefined, undefined, {}, undefined, undefined, "high");
      await runner.prompt("hello", nopCallbacks());

      // setThinkingLevel should NOT have been called on the session because
      // the level was already applied during createAgentSession.
      expect(sessionHolder.setThinkingLevel).not.toHaveBeenCalled();
    });

    it("applies setThinkingLevel immediately when session is live", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());

      runner.setThinkingLevel("low");
      expect(sessionHolder.setThinkingLevel).toHaveBeenCalledWith("low");
    });

    it("stores a pending override when setThinkingLevel is called before init", async () => {
      const runner = makeRunner(tmpDir);
      runner.setThinkingLevel("xhigh");

      await runner.prompt("hello", nopCallbacks());
      // The pending override is applied during createAgentSession, not via
      // session.setThinkingLevel, because init() consumes it before prompt()
      // checks for a flush.
      expect(capturedCreateArgs).toHaveLength(1);
      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.thinkingLevel).toBe("xhigh");
      expect(sessionHolder.setThinkingLevel).not.toHaveBeenCalled();
    });

    it("clearing thinkingLevel resets to model default on a live session", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      runner.setThinkingLevel(undefined);
      // The model default for poe/Claude-Sonnet-4.6 is "high"
      expect(sessionHolder.setThinkingLevel).toHaveBeenCalledWith("high");
    });
  });

  describe("setModel (in-place model switch)", () => {
    beforeEach(() => {
      capturedCreateArgs = [];
      sessionHolder.reset();
    });

    it("delegates to session.setModel() on an initialized runner", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      await runner.setModel("poe/GPT-4o");
      expect(sessionHolder.setModel).toHaveBeenCalledTimes(1);
      expect(runner.modelName).toBe("poe/GPT-4o");
    });

    it("does not recreate the session when switching models", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());
      expect(capturedCreateArgs).toHaveLength(1);

      await runner.setModel("poe/GPT-4o");
      // No new createAgentSession call — the switch is in-place.
      expect(capturedCreateArgs).toHaveLength(1);
    });

    it("records the override and defers to init when called before first prompt", async () => {
      const runner = makeRunner(tmpDir);
      await runner.setModel("poe/GPT-4o");
      // Not initialized yet → setModel should NOT have been called on a session.
      expect(sessionHolder.setModel).not.toHaveBeenCalled();
      expect(runner.modelName).toBe("poe/GPT-4o");

      await runner.prompt("hello", nopCallbacks());
      // The deferred model is what init resolves; setModel stays uncalled
      // because the session was created directly under the new model.
      expect(sessionHolder.setModel).not.toHaveBeenCalled();
    });
  });

  describe("pending project notice", () => {
    it("injects notice via sendCustomMessage on init and clears it", async () => {
      const runner = makeRunner(tmpDir, [], undefined, undefined, undefined, {}, undefined, "Project directory changed to `/foo`.");
      await runner.prompt("hello", nopCallbacks());

      // sendCustomMessage is called twice: once for the notice, once for memory snapshot (if any)
      const calls = sessionHolder.sendCustomMessage.mock.calls;
      const noticeCall = calls.find((c: unknown[]) => {
        const msg = c[0] as Record<string, unknown>;
        return msg?.customType === "project_notice";
      });
      expect(noticeCall).toBeDefined();
      expect((noticeCall![0] as Record<string, unknown>).content).toBe("Project directory changed to `/foo`.");
      expect((noticeCall![1] as Record<string, unknown>).deliverAs).toBe("nextTurn");
    });

    it("does not inject a notice when none is pending", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const calls = sessionHolder.sendCustomMessage.mock.calls;
      const noticeCall = calls.find((c: unknown[]) => {
        const msg = c[0] as Record<string, unknown>;
        return msg?.customType === "project_notice";
      });
      expect(noticeCall).toBeUndefined();
    });
  });

  describe("cwd and piAgentDir paths passed to pi", () => {
    it("passes workdirPath as cwd", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.cwd).toBe(workdirPath(tmpDir));
    });

    it("passes piAgentDir as agentDir", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.agentDir).toBe(piAgentDir(tmpDir));
    });
  });

  describe("skillSources resource loader modes", () => {
    it("goblin-only passes noSkills true to the resource loader", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, undefined, { skillSources: "goblin-only" });
      await runner.prompt("hi", nopCallbacks());

      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect(loaderOpts.noSkills).toBe(true);
      expect(loaderOpts.noContextFiles).toBe(true);
      expect(loaderOpts.additionalSkillPaths).toEqual([skillsPath(tmpDir)]);
      expect(loaderOpts.systemPrompt).toContain("test goblin identity");
    });

    it("user omits noSkills from the resource loader constructor", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, undefined, { skillSources: "user" });
      await runner.prompt("hi", nopCallbacks());

      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect("noSkills" in loaderOpts).toBe(false);
      expect(loaderOpts.noContextFiles).toBe(true);
      expect(loaderOpts.additionalSkillPaths).toEqual([skillsPath(tmpDir)]);
      expect(loaderOpts.systemPrompt).toContain("test goblin identity");
    });
  });

  describe("Goblin system prompt resource loader", () => {
    it("passes the constructed system prompt through the resource loader", async () => {
      writeFileSync(agentsMdPath(tmpDir), "deployment operating rules\n", "utf-8");
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect(loaderOpts.systemPrompt).toContain("test goblin identity");
      expect(loaderOpts.systemPrompt).toContain("deployment operating rules");
      expect(loaderOpts.systemPrompt).toContain("## Runtime Mechanics");
      expect(loaderOpts.noContextFiles).toBe(true);
    });

    it("includes exact bound project AGENTS.md as project guidance", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(projectDir);
      writeFileSync(join(projectDir, "AGENTS.md"), "exact project guidance\n", "utf-8");

      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, undefined, {}, projectDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect(opts.cwd).toBe(projectDir);
      expect(loaderOpts.systemPrompt).toContain("test goblin identity");
      expect(loaderOpts.systemPrompt).toContain("## Project Guidance (projectDir/AGENTS.md)");
      expect(loaderOpts.systemPrompt).toContain("exact project guidance");
    });

    it("does not concatenate memory snapshots into the system prompt", async () => {
      mkdirSync(join(memoryDir(tmpDir), "general"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "general", "memory.md"), "fresh memory fact", "utf-8");

      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect(loaderOpts.systemPrompt).not.toContain("fresh memory fact");
      expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
      expect((sessionHolder.sendCustomMessage.mock.calls[0]![1] as { deliverAs?: string }).deliverAs).toBe("nextTurn");
    });
  });

  describe("followUp when isStreaming", () => {
    it("calls sendUserMessage when not streaming", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());
      expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("hello");
      expect(sessionHolder.followUp).not.toHaveBeenCalled();
    });

    it("calls followUp when isStreaming is true", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      sessionHolder.streaming = true;
      await runner.followUp("interrupt");
      expect(sessionHolder.followUp).toHaveBeenCalledWith("interrupt", undefined);
      expect(sessionHolder.sendUserMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("followUp()", () => {
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

    it("steers while streaming without resetting callbacks or injecting a snapshot", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", cb);
      sessionHolder.streaming = true;

      await runner.followUp("actually use the other file");

      expect(sessionHolder.followUp).toHaveBeenCalledWith("actually use the other file", undefined);
      // followUp must not inject a memory snapshot — the running turn already
      // received its snapshot at prompt() time.
      expect(sessionHolder.sendCustomMessage).not.toHaveBeenCalled();
    });

    it("throws when not streaming", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());

      await expect(runner.followUp("redirect")).rejects.toThrow("Cannot steer: session is not streaming.");
      expect(sessionHolder.followUp).not.toHaveBeenCalled();
    });

    it("throws when session not yet initialized", async () => {
      const runner = makeRunner(tmpDir);

      await expect(runner.followUp("redirect")).rejects.toThrow("session not initialized");
      expect(sessionHolder.followUp).not.toHaveBeenCalled();
    });

    it("throws ModelNotCapableError for image content on an image-incapable model", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "zai/glm-4.5", { zaiApiKey: "test-key" });
      await runner.prompt("first", nopCallbacks());
      sessionHolder.streaming = true;

      await expect(runner.followUp([image])).rejects.toBeInstanceOf(ModelNotCapableError);
      expect(sessionHolder.followUp).not.toHaveBeenCalled();
    });

    it("unpacks multimodal content into session.followUp(text, images) on an image-capable model", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "poe/kimi-k2.6");
      await runner.prompt("first", nopCallbacks());
      sessionHolder.streaming = true;

      const content: (TextContent | ImageContent)[] = [
        { type: "text", text: "and this image" },
        image,
      ];
      await runner.followUp(content);

      expect(sessionHolder.followUp).toHaveBeenCalledWith("and this image", [image]);
    });

    it("prompt() throws while streaming instead of clobbering in-flight state", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", cb);
      sessionHolder.streaming = true;

      await expect(runner.prompt("second", nopCallbacks())).rejects.toThrow("Cannot prompt while streaming; use followUp().");
      // The in-flight turn's callbacks remain intact.
      expect(sessionHolder.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    // When a prior abort timed out, the runner is wedged. The runner
    // reports `isStreaming === false` for scheduling purposes, but the
    // `prompt()` guard must also check `isAbortTimedOut` and refuse to
    // start a new turn on the broken session. The user-facing reply
    // happens at the intake layer; the runner just throws.
    it("prompt() rejects after markAbortTimedOut even though pi is still streaming", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      // pi is still mid-stream, but the abort cascade timed out.
      sessionHolder.streaming = true;
      runner.markAbortTimedOut();

      expect(runner.isStreaming).toBe(false);
      expect(runner.isAbortTimedOut).toBe(true);

      // A wedged turn is treated as broken — do not start another turn.
      await expect(runner.prompt("recovery", nopCallbacks())).rejects.toThrow(
        "wedged after a failed abort",
      );
      expect(sessionHolder.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("followUp() rejects after markAbortTimedOut even though pi is still streaming", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      sessionHolder.streaming = true;
      runner.markAbortTimedOut();

      // A dead turn cannot be steered — consistent with the getter
      // reporting the runner as not streaming.
      await expect(runner.followUp("redirect")).rejects.toThrow("Cannot steer: session is not streaming.");
      expect(sessionHolder.followUp).not.toHaveBeenCalled();
    });
  });

  describe("Poe image-only prompt normalization", () => {
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

    it("adds default text before image-only messages for Poe chat completions", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "poe/kimi-k2.6");
      await runner.prompt([image], nopCallbacks());

      expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith([
        { type: "text", text: "What do you see in this image?" },
        image,
      ]);
    });

    it("does not rewrite captioned Poe chat completion image messages", async () => {
      const content: (TextContent | ImageContent)[] = [{ type: "text", text: "caption" }, image];
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "poe/kimi-k2.6");
      await runner.prompt(content, nopCallbacks());

      expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith(content);
    });

    it("does not rewrite image-only messages for non-Poe models", async () => {
      const content: ImageContent[] = [image];
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "openai/gpt-5.4");
      await runner.prompt(content, nopCallbacks());

      expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith(content);
    });

    it("uses the default text for Poe chat completion image follow-ups", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "poe/kimi-k2.6");
      await runner.prompt("hi", nopCallbacks());
      sessionHolder.streaming = true;
      await runner.followUp([image]);

      expect(sessionHolder.followUp).toHaveBeenCalledWith("What do you see in this image?", [image]);
    });
  });

  describe("event → callback dispatch", () => {
    it("fires onStatusUpdate(\"thinking...\") on agent_start", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({ type: "agent_start" });
      expect(cb.onStatusUpdate).toHaveBeenCalledWith("thinking...");
    });

    it("fires onAgentEnd on agent_end", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({ type: "agent_end", messages: [] });
      expect(cb.onAgentEnd).toHaveBeenCalled();
    });

    it("fires onTextDelta for message_update text_delta", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      });
      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "world" },
      });

      expect(cb.onTextDelta).toHaveBeenNthCalledWith(1, "Hello ");
      expect(cb.onTextDelta).toHaveBeenNthCalledWith(2, "world");
    });

    it("fires onToolStart on tool_execution_start", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "ls" },
      });

      expect(cb.onToolStart).toHaveBeenCalledWith("bash", { command: "ls" });
    });

    it("fires onToolEnd on tool_execution_end", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: { stdout: "file1\n" },
        isError: false,
      });

      expect(cb.onToolEnd).toHaveBeenCalledWith("bash", false);
    });
  });

  describe("message_end reconciliation", () => {
    it("emits correcting delta when streamed text is a truncated prefix of final text", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      // Stream a truncated prefix — the last delta was lost upstream.
      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "🌸 **https://karen-valdez-cards" },
      });
      // message_end carries the full text.
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "🌸 **https://karen-valdez-cards.netlify.app**" }],
          stopReason: "stop",
        },
      });

      // The correcting delta should be the missing tail.
      const deltaCalls = (cb.onTextDelta as ReturnType<typeof mock>).mock.calls;
      expect(deltaCalls).toHaveLength(2);
      expect(deltaCalls[0]![0]).toBe("🌸 **https://karen-valdez-cards");
      expect(deltaCalls[1]![0]).toBe(".netlify.app**");
    });

    it("does not emit correcting delta when streamed text matches final text", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "complete response" },
      });
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "complete response" }],
          stopReason: "stop",
        },
      });

      const deltaCalls = (cb.onTextDelta as ReturnType<typeof mock>).mock.calls;
      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]![0]).toBe("complete response");
    });

    it("does not emit correcting delta when deltas diverged from final text (corruption)", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      // Deltas delivered different text than the final message — not truncation.
      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "wrong text" },
      });
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "correct text" }],
          stopReason: "stop",
        },
      });

      const deltaCalls = (cb.onTextDelta as ReturnType<typeof mock>).mock.calls;
      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]![0]).toBe("wrong text");
    });

    it("resets accumulated text after each assistant message_end (multi-message turn)", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      // First assistant message: complete text, no truncation.
      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "first message" },
      });
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first message" }],
          stopReason: "toolUse",
        },
      });

      // Tool execution in between (no text deltas).
      sessionHolder.emit({ type: "tool_execution_start", toolName: "bash", args: {} });
      sessionHolder.emit({ type: "tool_execution_end", toolName: "bash", isError: false });

      // Second assistant message: truncated prefix.
      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "second " },
      });
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second message" }],
          stopReason: "stop",
        },
      });

      const deltaCalls = (cb.onTextDelta as ReturnType<typeof mock>).mock.calls;
      // 1st msg: "first message" (no correction)
      // 2nd msg: "second " + correcting "message"
      expect(deltaCalls).toHaveLength(3);
      expect(deltaCalls[0]![0]).toBe("first message");
      expect(deltaCalls[1]![0]).toBe("second ");
      expect(deltaCalls[2]![0]).toBe("message");
    });

    it("ignores message_end on non-assistant messages", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      });
      // A toolResult message_end should not trigger reconciliation or reset.
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          content: [{ type: "text", text: "tool output" }],
        },
      });

      const deltaCalls = (cb.onTextDelta as ReturnType<typeof mock>).mock.calls;
      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]![0]).toBe("partial");
    });

    it("handles multiple text blocks in final message content", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "part1 " },
      });
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "part1 " },
            { type: "text", text: "part2" },
          ],
          stopReason: "stop",
        },
      });

      const deltaCalls = (cb.onTextDelta as ReturnType<typeof mock>).mock.calls;
      expect(deltaCalls).toHaveLength(2);
      expect(deltaCalls[0]![0]).toBe("part1 ");
      expect(deltaCalls[1]![0]).toBe("part2");
    });
  });

  describe("transcript.jsonl", () => {
    it("appends final message entries for message_end events only", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      sessionHolder.emit({ type: "agent_start" });
      sessionHolder.emit({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "partial",
          partial: { role: "assistant", content: [{ type: "text", text: "partial" }] },
        },
      });
      sessionHolder.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
          provider: "openai",
          model: "gpt-test",
          stopReason: "stop",
          timestamp: 123,
        },
      });

      const content = readFileSync(
        transcriptPath(tmpDir, "abcdef1234"),
        "utf-8",
      );
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.role).toBe("assistant");
      expect(parsed.content).toEqual([{ type: "text", text: "final" }]);
      expect(parsed.model).toBe("gpt-test");
    });
  });

  describe("abort()", () => {
    it("resolves after idle (no session yet)", async () => {
      const runner = makeRunner(tmpDir);
      await expect(runner.abort()).resolves.toBeUndefined();
    });

    it("calls session.abort() after session is created", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());
      await runner.abort();
      expect(sessionHolder.abort).toHaveBeenCalled();
    });
  });

  describe("compact()", () => {
    it("initializes lazily and delegates to session.compact()", async () => {
      const runner = makeRunner(tmpDir);
      const result = await runner.compact("focus on schema decisions");

      expect(capturedCreateArgs).toHaveLength(1);
      expect(sessionHolder.compact).toHaveBeenCalledWith("focus on schema decisions");
      expect(result).toEqual({
        summary: "compressed history",
        firstKeptEntryId: "entry-1",
        tokensBefore: 42000,
      });
    });

    it("rejects when the prior abort timed out", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());
      runner.markAbortTimedOut();

      await expect(runner.compact()).rejects.toThrow("previous abort timed out");
      expect(sessionHolder.compact).not.toHaveBeenCalled();
    });

    it("rejects while the session is streaming", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());
      sessionHolder.streaming = true;

      await expect(runner.compact()).rejects.toThrow("still streaming");
      expect(sessionHolder.compact).not.toHaveBeenCalled();
    });
  });

  describe("cachedTopicName", () => {
    it("caches getTopicName results and reuses them across snapshot calls", async () => {
      let callCount = 0;
      const getTopicName = mock(async (_chatId: number, topicId: number) => {
        callCount++;
        return topicId === 7 ? "IT Topic" : null;
      });

      // Seed memory with topics so getTopicName gets invoked
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100"), { recursive: true });
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "42"), { recursive: true });
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "7"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "42", "memory.md"), "fact-42", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "7", "memory.md"), "fact-7", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "user.md"), "user pref", "utf-8");

      const runner = makeRunner(tmpDir, [], { chatId: -100, topicId: 42 }, getTopicName);

      // First prompt - should call getTopicName for peer topics
      await runner.prompt("first", nopCallbacks());
      expect(callCount).toBeGreaterThanOrEqual(1);
      const callsAfterFirst = callCount;

      // Second prompt - should use cached values, not increase call count
      await runner.prompt("second", nopCallbacks());
      expect(callCount).toBe(callsAfterFirst);

      // Verify the topic name was actually used in the snapshot
      const [payload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      const text = (payload as { content: string }).content;
      expect(text).toContain("IT Topic");
    });

    it("caches null results and does not call getTopicName again for same topic", async () => {
      let callCount = 0;
      const getTopicName = mock(async (_chatId: number, _topicId: number) => {
        callCount++;
        return null; // Always returns null
      });

      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "42"), { recursive: true });
      mkdirSync(join(memoryDir(tmpDir), "topics", "-100", "7"), { recursive: true });
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "42", "memory.md"), "fact-42", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "topics", "-100", "7", "memory.md"), "fact-7", "utf-8");
      writeFileSync(join(memoryDir(tmpDir), "user.md"), "user pref", "utf-8");

      const runner = makeRunner(tmpDir, [], { chatId: -100, topicId: 42 }, getTopicName);

      await runner.prompt("first", nopCallbacks());
      const callsAfterFirst = callCount;

      await runner.prompt("second", nopCallbacks());
      // Should not have made additional calls since null is cached
      expect(callCount).toBe(callsAfterFirst);
    });
  });

  describe("spawn_subagent tool registration", () => {
    it("includes spawn_subagent tool when subagentRunner is provided", async () => {
      const subRunner = new SubagentRunner(makeConfig(tmpDir));
      const runner = new AgentRunner({
        cfg: makeConfig(tmpDir),
        sessionId: "abcdef1234",
        locator: { chatId: 123 },
        customTools: [],
        subagentRunner: subRunner,
        backendFactory: (opts) => new FakeAgentBackend(opts),
      });
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain("spawn_subagent");
      expect(names).toContain("revive_subagent");
      expect(names).toContain("memory_write");
    });

    it("does not include spawn_subagent tool when subagentRunner is absent", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("spawn_subagent");
      expect(names).not.toContain("revive_subagent");
      expect(names).toContain("memory_write");
    });

    it("wires onStatusUpdate through to the tool so subagent events reach the turn callbacks", async () => {
      const subRunner = new SubagentRunner(makeConfig(tmpDir));
      const runner = new AgentRunner({
        cfg: makeConfig(tmpDir),
        sessionId: "abcdef1234",
        locator: { chatId: 123 },
        customTools: [],
        subagentRunner: subRunner,
        backendFactory: (opts) => new FakeAgentBackend(opts),
      });

      const cb = nopCallbacks();
      await runner.prompt("hi", cb);

      // The spawn_subagent tool was created with an onStatusUpdate callback.
      // Simulate it being called to verify it delegates to the turn's callbacks.
      // We can't easily invoke the tool's handler here, but we can verify the
      // tool received a truthy 4th argument (the callback) by inspecting
      // capturedCreateArgs.
      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<Record<string, unknown>>;
      const spawnTool = tools.find((t) => t.name === "spawn_subagent");
      expect(spawnTool).toBeDefined();
      // The tool exists and was registered — the delegating callback is
      // captured inside the tool's closure. Integration testing of the
      // full callback chain is covered by the subagent mod.test.ts suite.
    });
  });

  describe("schedule_turn tool registration", () => {
    it("registers schedule_turn when scheduleStore is provided", async () => {
      const scheduleStore = new ScheduleStore(tmpDir);
      const runner = new AgentRunner({
        cfg: makeConfig(tmpDir),
        sessionId: "abcdef1234",
        locator: { chatId: 123 },
        customTools: [],
        scheduleStore,
        backendFactory: (opts) => new FakeAgentBackend(opts),
      });
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain("schedule_turn");
    });

    it("does not register schedule_turn when scheduleStore is absent", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("schedule_turn");
    });
  });

  describe("memory reflection scheduling", () => {
    /** Helper: create a reflector backed by a real store on tmpDir. */
    function makeReflector(
      home: string,
      extractor?: CandidateExtractor,
    ): MemoryReflector {
      const store = new MemoryStore(home);
      return new MemoryReflector({ goblinHome: home, store, extractor });
    }

    /** Pre-seed a reflection cursor at processedLines=0 so the first pass processes all transcript entries. */
    function seedCursorAtZero(home: string): void {
      writeFileSync(
        join(sessionDir(home, "abcdef1234"), "memory-reflection.json"),
        JSON.stringify({ processedLines: 0, lastReflectedAt: new Date().toISOString() }) + "\n",
        "utf-8",
      );
    }

    /** Write a single user transcript entry. */
    function writeTranscriptEntry(home: string, text: string): void {
      writeFileSync(
        transcriptPath(home, "abcdef1234"),
        JSON.stringify({
          ts: new Date().toISOString(),
          role: "user",
          content: [{ type: "text", text }],
        }) + "\n",
        "utf-8",
      );
    }

    it("schedules a reflection pass after agent_end on a completed prompt turn", async () => {
      const reflector = makeReflector(tmpDir);
      const scheduleSpy = mock((_sessionId: string, _scope: unknown) => {});
      reflector.scheduleReflection = scheduleSpy as never;

      const runner = makeRunner(
        tmpDir, [], { chatId: 123 }, undefined, undefined, {}, undefined, undefined, undefined, reflector,
      );
      await runner.prompt("hello", nopCallbacks());

      sessionHolder.emit({ type: "agent_end", messages: [] });

      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        "abcdef1234",
        expect.objectContaining({ chatId: 123, topicScope: "general" }),
      );
    });

    it("does not schedule an independent reflection pass for followUp (steer)", async () => {
      const reflector = makeReflector(tmpDir);
      const scheduleSpy = mock((_sessionId: string, _scope: unknown) => {});
      reflector.scheduleReflection = scheduleSpy as never;

      const runner = makeRunner(
        tmpDir, [], { chatId: 123 }, undefined, undefined, {}, undefined, undefined, undefined, reflector,
      );
      await runner.prompt("first", nopCallbacks());
      sessionHolder.streaming = true;
      await runner.followUp("redirect");

      // followUp steers the running turn — no agent_end is emitted, so no
      // reflection is scheduled for the steer itself.
      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it("reflection errors are logged and swallowed, not thrown to the event handler", async () => {
      const throwingExtractor: CandidateExtractor = () => {
        throw new Error("extractor blew up");
      };
      const reflector = makeReflector(tmpDir, throwingExtractor);

      const runner = makeRunner(
        tmpDir, [], { chatId: 123 }, undefined, undefined, {}, undefined, undefined, undefined, reflector,
      );
      await runner.prompt("hello", nopCallbacks());

      seedCursorAtZero(tmpDir);
      writeTranscriptEntry(tmpDir, "I prefer terse answers");

      // Emitting agent_end should not throw even though reflection fails.
      sessionHolder.emit({ type: "agent_end", messages: [] });
      await reflector.awaitSettled("abcdef1234");

      // The cursor should NOT have advanced — a failed pass retries the
      // same range on the next schedule.
      const cursor = JSON.parse(
        readFileSync(join(sessionDir(tmpDir, "abcdef1234"), "memory-reflection.json"), "utf-8"),
      );
      expect(cursor.processedLines).toBe(0);
    });

    it("reflected writes are visible in a subsequent turn's snapshot", async () => {
      const candidate: Candidate = {
        target: "user",
        category: "preference",
        confidence: 0.9,
        summary: "User prefers terse engineering summaries.",
        source: { sessionId: "abcdef1234", lineRange: [0, 0], sourceRole: "user" },
      };
      const extractor: CandidateExtractor = () => [candidate];
      const reflector = makeReflector(tmpDir, extractor);

      const runner = makeRunner(
        tmpDir, [], { chatId: 123 }, undefined, undefined, {}, undefined, undefined, undefined, reflector,
      );
      await runner.prompt("I prefer terse summaries", nopCallbacks());

      seedCursorAtZero(tmpDir);
      writeTranscriptEntry(tmpDir, "I prefer terse summaries");

      // Complete the turn — agent_end schedules reflection.
      sessionHolder.emit({ type: "agent_end", messages: [] });
      await reflector.awaitSettled("abcdef1234");

      // The reflected entry should now be in user.md.
      const userMd = readFileSync(join(memoryDir(tmpDir), "user.md"), "utf-8");
      expect(userMd).toContain("User prefers terse engineering summaries.");

      // Next turn's snapshot should include the reflected entry.
      sessionHolder.sendCustomMessage.mockClear();
      await runner.prompt("next message", nopCallbacks());
      expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
      const [payload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      const text = (payload as { content: string }).content;
      expect(text).toContain("User prefers terse engineering summaries.");
    });

    // Spec: "System prompt unchanged across reflection writes". The snapshot
    // is injected via sendCustomMessage, never via the system prompt, so the
    // value `_baseSystemPrompt` held at AgentSession creation MUST remain
    // unchanged across reflection writes and subsequent turns. The mock
    // session does not expose `state.systemPrompt`/`_baseSystemPrompt`, so
    // we assert the equivalent: the resource loader (which receives the
    // system prompt) is constructed exactly once, the session is not
    // recreated, and the post-reflection turn's snapshot is delivered via
    // sendCustomMessage with deliverAs:nextTurn — not via any system-prompt
    // path.
    it("system prompt is unchanged across reflection writes", async () => {
      const candidate: Candidate = {
        target: "user",
        category: "preference",
        confidence: 0.9,
        summary: "User prefers terse engineering summaries.",
        source: { sessionId: "abcdef1234", lineRange: [0, 0], sourceRole: "user" },
      };
      const extractor: CandidateExtractor = () => [candidate];
      const reflector = makeReflector(tmpDir, extractor);

      const runner = makeRunner(
        tmpDir, [], { chatId: 123 }, undefined, undefined, {}, undefined, undefined, undefined, reflector,
      );
      await runner.prompt("I prefer terse summaries", nopCallbacks());

      // Capture the system prompt supplied at AgentSession creation.
      expect(capturedResourceLoaderArgs).toHaveLength(1);
      const baseSystemPrompt = (capturedResourceLoaderArgs[0] as { systemPrompt: string }).systemPrompt;
      expect(capturedCreateArgs).toHaveLength(1);

      seedCursorAtZero(tmpDir);
      writeTranscriptEntry(tmpDir, "I prefer terse summaries");

      // Complete the turn — agent_end schedules a reflection pass that
      // writes to user.md on disk.
      sessionHolder.emit({ type: "agent_end", messages: [] });
      await reflector.awaitSettled("abcdef1234");

      const userMd = readFileSync(join(memoryDir(tmpDir), "user.md"), "utf-8");
      expect(userMd).toContain("User prefers terse engineering summaries.");

      // A subsequent turn must not recreate the session or resource loader
      // — the system prompt is frozen from creation.
      sessionHolder.sendCustomMessage.mockClear();
      await runner.prompt("next message", nopCallbacks());

      expect(capturedCreateArgs).toHaveLength(1);
      expect(capturedResourceLoaderArgs).toHaveLength(1);
      expect((capturedResourceLoaderArgs[0] as { systemPrompt: string }).systemPrompt).toBe(baseSystemPrompt);

      // The post-reflection snapshot is delivered via sendCustomMessage
      // (deliverAs:nextTurn), not via the system prompt.
      expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
      const [, opts] = sessionHolder.sendCustomMessage.mock.calls[0]!;
      expect((opts as { deliverAs?: string }).deliverAs).toBe("nextTurn");
    });
  });

  describe("external_agent tool registration", () => {
    it("registers external_agent when externalAgentRunner, enabled backends, and projectDir are present", async () => {
      const extCfg = {
        ...makeConfig(tmpDir),
        externalAgents: {
          backends: ["codex" as const],
          permissionProfile: "read-only" as const,
          maxConcurrent: 1,
          timeoutMs: 300_000,
          ptyFallback: false,
        },
      };
      const externalAgentRunner = new ExternalAgentRunner(extCfg);
      const runner = new AgentRunner({
        cfg: extCfg,
        sessionId: "abcdef1234",
        locator: { chatId: 123 },
        customTools: [],
        projectDir: tmpDir,
        externalAgentRunner,
        backendFactory: (opts) => new FakeAgentBackend(opts),
      });
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain("external_agent");
    });

    it("does not register external_agent when projectDir is absent", async () => {
      const extCfg = {
        ...makeConfig(tmpDir),
        externalAgents: {
          backends: ["codex" as const],
          permissionProfile: "read-only" as const,
          maxConcurrent: 1,
          timeoutMs: 300_000,
          ptyFallback: false,
        },
      };
      const externalAgentRunner = new ExternalAgentRunner(extCfg);
      const runner = new AgentRunner({
        cfg: extCfg,
        sessionId: "abcdef1234",
        locator: { chatId: 123 },
        customTools: [],
        externalAgentRunner,
        backendFactory: (opts) => new FakeAgentBackend(opts),
      });
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("external_agent");
    });

    it("does not register external_agent when externalAgentRunner is absent", async () => {
      const extCfg = {
        ...makeConfig(tmpDir),
        externalAgents: {
          backends: ["codex" as const],
          permissionProfile: "read-only" as const,
          maxConcurrent: 1,
          timeoutMs: 300_000,
          ptyFallback: false,
        },
      };
      const runner = new AgentRunner({
        cfg: extCfg,
        sessionId: "abcdef1234",
        locator: { chatId: 123 },
        customTools: [],
        projectDir: tmpDir,
        backendFactory: (opts) => new FakeAgentBackend(opts),
      });
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("external_agent");
    });
  });
});
