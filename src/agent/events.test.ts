import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscriptEntry,
  dispatchAgentEvent,
  extractAssistantText,
  type TurnCallbacks,
} from "./events.ts";

describe("appendTranscriptEntry", () => {
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-transcript-test-"));
    sessionId = "test-session-123";
    const sessionDir = join(tmpDir, "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores events that are not message_end", () => {
    appendTranscriptEntry(sessionId, tmpDir, { type: "message_start", message: { role: "user" } });

    // File shouldn't be created since nothing was written
    const transcriptPath = join(tmpDir, "sessions", sessionId, "transcript.jsonl");
    expect(existsSync(transcriptPath)).toBe(false);
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
        responseModel: "gpt-test-20260305",
        responseId: "resp-abc123",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 10,
          totalTokens: 180,
          cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
        },
        stopReason: "toolUse",
        timestamp: 456,
      },
    });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.role).toBe("assistant");
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-test");
    expect(parsed.responseModel).toBe("gpt-test-20260305");
    expect(parsed.responseId).toBe("resp-abc123");
    expect(parsed.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
    });
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

  it("omits usage when not present on assistant message", () => {
    appendTranscriptEntry(sessionId, tmpDir, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-completions",
        provider: "poe",
        model: "test-model",
        stopReason: "stop",
        timestamp: 100,
      },
    });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.role).toBe("assistant");
    expect(parsed.usage).toBeUndefined();
    expect(parsed.responseModel).toBeUndefined();
    expect(parsed.responseId).toBeUndefined();
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
    // agent_start is the turn-start cue that covers plain-text turns where
    // no thinking block and no tools arrive — the placeholder + typing
    // indicator must fire before the model streams.
    const cb = mockCallbacks();
    dispatchAgentEvent({ type: "agent_start" } as any, cb);
    expect(cb.calls).toEqual(["onStatusUpdate:thinking..."]);
  });

  it("fires onStatusUpdate(\"thinking...\") on thinking_start", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "message_update", assistantMessageEvent: { type: "thinking_start" } } as any,
      cb,
    );
    expect(cb.calls).toEqual(["onStatusUpdate:thinking..."]);
  });

  it("fires onStatusUpdate(\"thinking...\") on thinking_delta", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent(
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } } as any,
      cb,
    );
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

  it("ignores message_update with irrelevant assistantMessageEvent", () => {
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

  it("fires onStatusUpdate with unknown tokens on compaction_end without tokensBefore", () => {
    const cb = mockCallbacks();
    dispatchAgentEvent({ type: "compaction_end", result: {} } as any, cb);
    expect(cb.calls).toEqual(["onStatusUpdate:compacted from unknown tokens"]);
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

describe("extractAssistantText", () => {
  it("returns undefined for non-message_end events", () => {
    expect(extractAssistantText({ type: "agent_start" })).toBeUndefined();
    expect(extractAssistantText({ type: "message_update" })).toBeUndefined();
  });

  it("returns undefined for non-assistant messages", () => {
    expect(
      extractAssistantText({
        type: "message_end",
        message: { role: "user", content: "hello" },
      }),
    ).toBeUndefined();
    expect(
      extractAssistantText({
        type: "message_end",
        message: { role: "toolResult", content: [{ type: "text", text: "out" }] },
      }),
    ).toBeUndefined();
  });

  it("concatenates all text blocks in order", () => {
    expect(
      extractAssistantText({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "part1 " },
            { type: "toolCall", id: "c1", name: "bash", arguments: {} },
            { type: "text", text: "part2" },
          ],
        },
      }),
    ).toBe("part1 part2");
  });

  it("returns string content directly", () => {
    expect(
      extractAssistantText({
        type: "message_end",
        message: { role: "assistant", content: "plain string content" },
      }),
    ).toBe("plain string content");
  });

  it("returns undefined when content has no text blocks", () => {
    expect(
      extractAssistantText({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "only thinking" }],
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when message is missing", () => {
    expect(extractAssistantText({ type: "message_end" })).toBeUndefined();
  });

  it("returns undefined for empty text blocks", () => {
    expect(
      extractAssistantText({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
      }),
    ).toBeUndefined();
  });
});
