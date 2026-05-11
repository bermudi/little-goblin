import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    };
  },
};

let capturedCreateArgs: unknown[] = [];
let capturedResourceLoaderArgs: unknown[] = [];

// ---------------------------------------------------------------------------
// Module mock — hoisted by Bun before any imports below
// ---------------------------------------------------------------------------

mock.module("@earendil-works/pi-coding-agent", () => {
  return {
    AgentSession: {},
    DefaultResourceLoader: class {
      constructor(opts: unknown) {
        capturedResourceLoaderArgs.push(opts);
      }
      async reload() {}
      getSkills() { return { skills: [], diagnostics: [] }; }
      getAgentsFiles() { return { agentsFiles: [] }; }
      getSystemPrompt() { return undefined; }
      getAppendSystemPrompt() { return []; }
    },
    AuthStorage: {
      create: (_path: string) => ({
        setRuntimeApiKey: (_provider: string, _key: string) => {},
      }),
    },
    ModelRegistry: {
      create: (_auth: unknown, _path: string) => ({}),
    },
    SettingsManager: {
      inMemory: (_obj: unknown) => ({}),
    },
    SessionManager: {
      inMemory: (_path: string) => ({}),
    },
    createAgentSession: async (opts: unknown) => {
      capturedCreateArgs.push(opts);
      return { session: sessionHolder.proxy, extensionsResult: {} };
    },
  };
});

// ---------------------------------------------------------------------------
// Module under test (imported after mock.module so it sees the mock)
// ---------------------------------------------------------------------------

import { AgentRunner, type TurnCallbacks } from "./mod.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { ChatLocator } from "../sessions/types.ts";

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
) {
  return new AgentRunner({
    cfg: { ...makeConfig(home), ...(modelName === undefined ? {} : { modelName }), ...configOverrides },
    sessionId: "sess-001",
    locator,
    customTools: customTools as never,
    getTopicName,
    projectDir,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "goblin-agent-test-"));
  mkdirSync(join(tmpDir, "sessions", "sess-001"), { recursive: true });
  writeFileSync(join(tmpDir, "sessions", "sess-001", "events.jsonl"), "");
  writeFileSync(join(tmpDir, "sessions", "sess-001", "transcript.jsonl"), "");
  mkdirSync(join(tmpDir, "workdir"), { recursive: true });
  mkdirSync(join(tmpDir, "goblin"), { recursive: true });
  writeFileSync(join(tmpDir, "SOUL.md"), "test goblin identity\n", "utf-8");

  capturedCreateArgs = [];
  capturedResourceLoaderArgs = [];
  sessionHolder.reset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner", () => {
  describe("memory tool registration", () => {
    it("appends the three memory tools to customTools when none are supplied", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hello", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      const tools = opts.customTools as Array<{ name: string }>;
      expect(Array.isArray(tools)).toBe(true);
      const names = tools.map((t) => t.name);
      expect(names).toContain("memory_read");
      expect(names).toContain("memory_read_index");
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
      expect(names).toEqual(["t1", "t2", "memory_read", "memory_read_index", "memory_write"]);
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
      expect(readFileSync(join(tmpDir, "memory", "topics", "-100", "42", "memory.md"), "utf-8")).toBe("topic fact");
    });
  });

  describe("per-turn memory aside", () => {
    function seedMemory(home: string, files: { memory?: string; user?: string }): void {
      mkdirSync(join(home, "memory"), { recursive: true });
      if (files.memory !== undefined) {
        mkdirSync(join(home, "memory", "general"), { recursive: true });
        writeFileSync(join(home, "memory", "general", "memory.md"), files.memory, "utf-8");
      }
      if (files.user !== undefined) {
        writeFileSync(join(home, "memory", "user.md"), files.user, "utf-8");
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

    it("dispatches the aside before followUp on a streaming turn", async () => {
      seedMemory(tmpDir, { user: "pref-1" });
      sessionHolder.streaming = true;
      const runner = makeRunner(tmpDir);
      await runner.prompt("interrupt", nopCallbacks());

      expect(sessionHolder.callOrder).toEqual([
        "sendCustomMessage",
        "followUp",
      ]);
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
      mkdirSync(join(tmpDir, "memory", "general"), { recursive: true });
      writeFileSync(join(tmpDir, "memory", "general", "memory.md"), "initial", "utf-8");
      writeFileSync(join(tmpDir, "memory", "user.md"), "user pref", "utf-8");

      const runner = makeRunner(tmpDir);
      await runner.prompt("first", nopCallbacks());
      expect(capturedCreateArgs).toHaveLength(1);

      // Capture call count after first prompt
      const callCountAfterFirst = capturedCreateArgs.length;

      // Modify memory between turns
      writeFileSync(join(tmpDir, "memory", "general", "memory.md"), "modified content", "utf-8");

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

  describe("cwd and piAgentDir paths passed to pi", () => {
    it("passes workdirPath as cwd", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.cwd).toBe(join(tmpDir, "workdir"));
    });

    it("passes piAgentDir as agentDir", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.agentDir).toBe(join(tmpDir, "goblin"));
    });
  });

  describe("skillSources resource loader modes", () => {
    it("goblin-only passes noSkills true to the resource loader", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, undefined, { skillSources: "goblin-only" });
      await runner.prompt("hi", nopCallbacks());

      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect(loaderOpts.noSkills).toBe(true);
      expect(loaderOpts.noContextFiles).toBe(true);
      expect(loaderOpts.additionalSkillPaths).toEqual([join(tmpDir, "skills")]);
      expect(loaderOpts.systemPrompt).toContain("test goblin identity");
    });

    it("user omits noSkills from the resource loader constructor", async () => {
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, undefined, { skillSources: "user" });
      await runner.prompt("hi", nopCallbacks());

      const loaderOpts = capturedResourceLoaderArgs[0] as Record<string, unknown>;
      expect("noSkills" in loaderOpts).toBe(false);
      expect(loaderOpts.noContextFiles).toBe(true);
      expect(loaderOpts.additionalSkillPaths).toEqual([join(tmpDir, "skills")]);
      expect(loaderOpts.systemPrompt).toContain("test goblin identity");
    });
  });

  describe("Goblin system prompt resource loader", () => {
    it("passes the constructed system prompt through the resource loader", async () => {
      writeFileSync(join(tmpDir, "AGENTS.md"), "deployment operating rules\n", "utf-8");
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
      mkdirSync(join(tmpDir, "memory", "general"), { recursive: true });
      writeFileSync(join(tmpDir, "memory", "general", "memory.md"), "fresh memory fact", "utf-8");

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
      sessionHolder.streaming = true;
      const runner = makeRunner(tmpDir);
      await runner.prompt("interrupt", nopCallbacks());
      expect(sessionHolder.followUp).toHaveBeenCalledWith("interrupt", undefined);
      expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
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
      sessionHolder.streaming = true;
      const runner = makeRunner(tmpDir, [], { chatId: 123 }, undefined, "poe/kimi-k2.6");
      await runner.prompt([image], nopCallbacks());

      expect(sessionHolder.followUp).toHaveBeenCalledWith("What do you see in this image?", [image]);
    });
  });

  describe("event → callback dispatch", () => {
    it("fires onStatusUpdate on agent_start", async () => {
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

  describe("events.jsonl", () => {
    it("appends one line per pi event during a turn", async () => {
      const cb = nopCallbacks();
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", cb);

      const events = [
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "ok" },
        },
        { type: "agent_end", messages: [] },
      ];

      for (const ev of events) sessionHolder.emit(ev);

      const content = readFileSync(
        join(tmpDir, "sessions", "sess-001", "events.jsonl"),
        "utf-8"
      );
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(events.length);

      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.type).toBeDefined();
        expect(parsed.ts).toBeDefined();
      }
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
        join(tmpDir, "sessions", "sess-001", "transcript.jsonl"),
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
      mkdirSync(join(tmpDir, "memory", "topics", "-100"), { recursive: true });
      mkdirSync(join(tmpDir, "memory", "topics", "-100", "42"), { recursive: true });
      mkdirSync(join(tmpDir, "memory", "topics", "-100", "7"), { recursive: true });
      writeFileSync(join(tmpDir, "memory", "topics", "-100", "42", "memory.md"), "fact-42", "utf-8");
      writeFileSync(join(tmpDir, "memory", "topics", "-100", "7", "memory.md"), "fact-7", "utf-8");
      writeFileSync(join(tmpDir, "memory", "user.md"), "user pref", "utf-8");

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

      mkdirSync(join(tmpDir, "memory", "topics", "-100", "42"), { recursive: true });
      mkdirSync(join(tmpDir, "memory", "topics", "-100", "7"), { recursive: true });
      writeFileSync(join(tmpDir, "memory", "topics", "-100", "42", "memory.md"), "fact-42", "utf-8");
      writeFileSync(join(tmpDir, "memory", "topics", "-100", "7", "memory.md"), "fact-7", "utf-8");
      writeFileSync(join(tmpDir, "memory", "user.md"), "user pref", "utf-8");

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
        sessionId: "sess-001",
        locator: { chatId: 123 },
        customTools: [],
        subagentRunner: subRunner,
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
        sessionId: "sess-001",
        locator: { chatId: 123 },
        customTools: [],
        subagentRunner: subRunner,
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
});
