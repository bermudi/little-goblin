import { describe, it, expect } from "bun:test";
import type { Bot } from "grammy";
import { MessageBuffer } from "./buffer.ts";

function makeBot(): Bot {
  return {} as unknown as Bot;
}

describe("MessageBuffer", () => {
  it("instantiates with default visibility", () => {
    const buffer = new MessageBuffer(makeBot(), 123);
    const s = buffer._state();
    expect(s.chatId).toBe(123);
    expect(s.visibility).toBe("standard");
    expect(s.statusMessageId).toBeUndefined();
    expect(s.responseMessageId).toBeUndefined();
    expect(s.accumulatedText).toBe("");
    expect(s.toolStates.size).toBe(0);
    expect(s.lastEditTime).toBe(0);
    expect(s.isStreaming).toBe(false);
  });

  it("respects visibility option", () => {
    const buffer = new MessageBuffer(makeBot(), 7, { visibility: "verbose" });
    expect(buffer._state().visibility).toBe("verbose");
  });

  it("exposes all TurnCallbacks methods as no-ops in phase 1", () => {
    const buffer = new MessageBuffer(makeBot(), 1);
    expect(() => buffer.onTextDelta("hi")).not.toThrow();
    expect(() => buffer.onToolStart("bash", {})).not.toThrow();
    expect(() => buffer.onToolEnd("bash", {})).not.toThrow();
    expect(() => buffer.onStatusUpdate("thinking")).not.toThrow();
    expect(() => buffer.onAgentEnd()).not.toThrow();
  });
});
