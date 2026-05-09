import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  appendTranscriptEntry,
  dispatchAgentEvent,
  type TurnCallbacks,
} from "./events.ts";

describe("appendEvent", () => {
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-events-test-"));
    sessionId = "test-session-123";
    // Create session directory and empty events.jsonl
    const sessionDir = join(tmpDir, "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "");
    writeFileSync(join(sessionDir, "transcript.jsonl"), "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a single event", () => {
    appendEvent(sessionId, tmpDir, { type: "test", data: "hello" });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("test");
    expect(parsed.data).toBe("hello");
    expect(parsed.ts).toBeDefined();
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves existing ts if already present", () => {
    const customTs = "2024-01-15T10:30:00.000Z";
    appendEvent(sessionId, tmpDir, { type: "test", ts: customTs });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "events.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.ts).toBe(customTs);
  });

  it("writes 1000 events concurrently without corruption", async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(
        new Promise<void>((resolve) => {
          appendEvent(sessionId, tmpDir, { type: "concurrent", index: i });
          resolve();
        })
      );
    }

    await Promise.all(promises);

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1000);

    // Verify every line is valid JSON
    const indices = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe("concurrent");
      expect(typeof parsed.index).toBe("number");
      expect(parsed.ts).toBeDefined();
      indices.add(parsed.index);
    }

    // Verify all indices are unique and present
    expect(indices.size).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(indices.has(i)).toBe(true);
    }
  });

  it("creates file if it does not exist", () => {
    const newSessionId = "new-session-456";
    const sessionDir = join(tmpDir, "sessions", newSessionId);
    mkdirSync(sessionDir, { recursive: true });
    // Don't create events.jsonl

    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(false);

    appendEvent(newSessionId, tmpDir, { type: "first" });

    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
    const content = readFileSync(join(sessionDir, "events.jsonl"), "utf-8");
    expect(content.trim()).not.toBe("");
  });

  it("strips message and assistantMessageEvent.partial from message_update", () => {
    appendEvent(sessionId, tmpDir, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    });

    const content = readFileSync(
      join(tmpDir, "sessions", sessionId, "events.jsonl"),
      "utf-8",
    );
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("message_update");
    expect(parsed.message).toBeUndefined();
    expect(parsed.assistantMessageEvent).toBeDefined();
    expect(parsed.assistantMessageEvent.partial).toBeUndefined();
    expect(parsed.assistantMessageEvent.delta).toBe("hi");
    expect(parsed.ts).toBeDefined();
  });

  it("preserves non-message_update events intact", () => {
    appendEvent(sessionId, tmpDir, {
      type: "message_end",
      message: { role: "assistant", content: [] },
    });

    const content = readFileSync(
      join(tmpDir, "sessions", sessionId, "events.jsonl"),
      "utf-8",
    );
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("message_end");
    expect(parsed.message).toBeDefined();
    expect(parsed.ts).toBeDefined();
  });
});

describe("appendTranscriptEntry", () => {
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-transcript-test-"));
    sessionId = "test-session-123";
    const sessionDir = join(tmpDir, "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "transcript.jsonl"), "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores events that are not message_end", () => {
    appendTranscriptEntry(sessionId, tmpDir, { type: "message_start", message: { role: "user" } });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
    expect(content).toBe("");
  });

  it("appends user messages", () => {
    appendTranscriptEntry(sessionId, tmpDir, {
      type: "message_end",
      ts: "2026-05-07T20:00:00.000Z",
      message: { role: "user", content: "hello goblin", timestamp: 123 },
    });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual({
      ts: "2026-05-07T20:00:00.000Z",
      role: "user",
      timestamp: 123,
      content: "hello goblin",
    });
  });

  it("appends assistant messages without provider signatures or image data", () => {
    appendTranscriptEntry(sessionId, tmpDir, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "secret-ish-provider-state" },
          { type: "text", text: "hi", textSignature: "provider-state" },
          { type: "image", mimeType: "image/png", data: "base64-data" },
          { type: "toolCall", id: "call-1", name: "memory_read", arguments: { target: "user" } },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: { totalTokens: 10 },
        stopReason: "toolUse",
        timestamp: 456,
      },
    });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.role).toBe("assistant");
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-test");
    expect(parsed.stopReason).toBe("toolUse");
    expect(parsed.content).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "hi" },
      { type: "image", mimeType: "image/png" },
      { type: "toolCall", id: "call-1", name: "memory_read", arguments: { target: "user" } },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("provider-state");
    expect(JSON.stringify(parsed)).not.toContain("base64-data");
  });

  it("appends tool result messages", () => {
    appendTranscriptEntry(sessionId, tmpDir, {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "memory_read",
        content: [{ type: "text", text: "done" }],
        details: { verbose: "not copied" },
        isError: false,
        timestamp: 789,
      },
    });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual({
      ts: expect.any(String),
      role: "toolResult",
      timestamp: 789,
      content: [{ type: "text", text: "done" }],
      toolCallId: "call-1",
      toolName: "memory_read",
      isError: false,
    });
  });
});

describe("dispatchAgentEvent", () => {
  /** Build a TurnCallbacks that records every call. */
  function mockCallbacks(): TurnCallbacks & {
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      onTextDelta: (text) => calls.push(`onTextDelta:${text}`),
      onToolStart: (name, input) => calls.push(`onToolStart:${name}:${JSON.stringify(input)}`),
      onToolEnd: (name, isError) => calls.push(`onToolEnd:${name}:${isError}`),
      onStatusUpdate: (msg) => calls.push(`onStatusUpdate:${msg}`),
      onAgentEnd: () => calls.push("onAgentEnd"),
    };
  }

  it("fires onStatusUpdate(\"thinking...\") on agent_start", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent({ type: "agent_start" } as any, cb);
    expect(cb.calls).toEqual(["onStatusUpdate:thinking..."]);
  });

  it("fires onTextDelta for message_update text_delta", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } } as any,
      cb,
    );
    expect(cb.calls).toEqual(["onTextDelta:hello"]);
  });

  it("ignores message_update with non-text-delta assistantMessageEvent", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "message_update", assistantMessageEvent: { type: "message_start" } } as any,
      cb,
    );
    expect(cb.calls).toEqual([]);
  });

  it("fires onToolStart on tool_execution_start", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } } as any,
      cb,
    );
    expect(cb.calls).toEqual(["onToolStart:bash:{\"cmd\":\"ls\"}"]);
  });

  it("fires onToolEnd on tool_execution_end with isError=true", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "tool_execution_end", toolName: "bash", isError: true } as any,
      cb,
    );
    expect(cb.calls).toEqual(["onToolEnd:bash:true"]);
  });

  it("fires onToolEnd on tool_execution_end with isError=false (missing field)", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "tool_execution_end", toolName: "read" } as any,
      cb,
    );
    expect(cb.calls).toEqual(["onToolEnd:read:false"]);
  });

  it("fires onAgentEnd on agent_end", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent({ type: "agent_end", messages: [] } as any, cb);
    expect(cb.calls).toEqual(["onAgentEnd"]);
  });

  it("surfaces assistant message_end error as visible text", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "401 Incorrect API key provided.",
        },
      } as any,
      cb,
    );
    expect(cb.calls).toEqual([
      "onTextDelta:\n\n❌ error: 401 Incorrect API key provided.",
    ]);
  });

  it("surfaces assistant message_end aborted as visible text", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "user aborted",
        },
      } as any,
      cb,
    );
    expect(cb.calls).toEqual(["onTextDelta:\n\n❌ aborted: user aborted"]);
  });

  it("ignores message_end on successful assistant message", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stopReason: "stop",
        },
      } as any,
      cb,
    );
    expect(cb.calls).toEqual([]);
  });

  it("ignores message_end with error stopReason but no errorMessage", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error" },
      } as any,
      cb,
    );
    expect(cb.calls).toEqual([]);
  });

  it("ignores message_end on user/tool-result messages", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      {
        type: "message_end",
        message: { role: "user", content: "hello" },
      } as any,
      cb,
    );
    expect(cb.calls).toEqual([]);
  });

  it("fires onStatusUpdate on compaction_start", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent({ type: "compaction_start" } as any, cb);
    expect(cb.calls).toEqual(["onStatusUpdate:🗜 compacting…"]);
  });

  it("fires onStatusUpdate on compaction_end", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent({ type: "compaction_end", result: { tokensBefore: 42000 } } as any, cb);
    expect(cb.calls).toEqual(["onStatusUpdate:compacted from ~42k tokens"]);
  });

  it("ignores unknown event types without throwing", () => {
    const cb = mockCallbacks();
    expect(() => {
      dispatchAgentEvent({ type: "turn_start" } as any, cb);
      dispatchAgentEvent({ type: "some_future_event" } as any, cb);
    }).not.toThrow();
    expect(cb.calls).toEqual([]);
  });
});
