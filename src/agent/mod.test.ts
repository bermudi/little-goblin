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
  sendUserMessage: mock(async (_text: string) => {}),
  followUp: mock(async (_text: string) => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),

  reset() {
    this.listeners = [];
    this.streaming = false;
    this.sendUserMessage = mock(async (_text: string) => {});
    this.followUp = mock(async (_text: string) => {});
    this.abort = mock(async () => {});
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
      sendUserMessage: (text: string) => holder.sendUserMessage(text),
      followUp: (text: string) => holder.followUp(text),
      abort: () => holder.abort(),
      dispose: () => holder.dispose(),
    };
  },
};

let capturedCreateArgs: unknown[] = [];

// ---------------------------------------------------------------------------
// Module mock — hoisted by Bun before any imports below
// ---------------------------------------------------------------------------

mock.module("@mariozechner/pi-coding-agent", () => {
  return {
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
import type { Config } from "../config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
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

function makeRunner(home: string, customTools: unknown[] = []) {
  return new AgentRunner(makeConfig(home), "sess-001", customTools as never);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "goblin-agent-test-"));
  mkdirSync(join(tmpDir, "sessions", "sess-001"), { recursive: true });
  writeFileSync(join(tmpDir, "sessions", "sess-001", "events.jsonl"), "");
  mkdirSync(join(tmpDir, "workdir"), { recursive: true });
  mkdirSync(join(tmpDir, "pi-agent"), { recursive: true });

  capturedCreateArgs = [];
  sessionHolder.reset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner", () => {
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
  });

  describe("cwd and piAgentDir paths passed to pi", () => {
    it("passes workdirPath as cwd", async () => {
      const runner = makeRunner(tmpDir);
      await runner.prompt("hi", nopCallbacks());

      const opts = capturedCreateArgs[0] as Record<string, unknown>;
      expect(opts.cwd).toBe(join(tmpDir, "workdir"));
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
      expect(sessionHolder.followUp).toHaveBeenCalledWith("interrupt");
      expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
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
});
