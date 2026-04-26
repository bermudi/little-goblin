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

  it("exposes all TurnCallbacks methods without throwing", () => {
    const buffer = new MessageBuffer(makeBot(), 1);
    expect(() => buffer.onTextDelta("hi")).not.toThrow();
    expect(() => buffer.onToolStart("bash", {})).not.toThrow();
    expect(() => buffer.onToolEnd("bash", false)).not.toThrow();
    expect(() => buffer.onStatusUpdate("thinking")).not.toThrow();
    expect(() => buffer.onAgentEnd()).not.toThrow();
  });

  describe("status line state machine", () => {
    it("renders empty string when no tool activity", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      expect(buffer.buildStatusLine()).toBe("");
    });

    it("marks a tool as running on onToolStart", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onToolStart("bash", { command: "ls" });
      expect(buffer.buildStatusLine()).toBe("🔧 bash");
      expect(buffer._state().toolStates.get("bash")).toBe("running");
    });

    it("transitions running → success on onToolEnd(false)", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onToolStart("bash", {});
      buffer.onToolEnd("bash", false);
      expect(buffer.buildStatusLine()).toBe("✅ bash");
      expect(buffer._state().toolStates.get("bash")).toBe("success");
    });

    it("transitions running → error on onToolEnd(true)", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onToolStart("bash", {});
      buffer.onToolEnd("bash", true);
      expect(buffer.buildStatusLine()).toBe("❌ bash");
      expect(buffer._state().toolStates.get("bash")).toBe("error");
    });

    it("preserves insertion order for multiple tools", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onToolStart("read", {});
      buffer.onToolEnd("read", false);
      buffer.onToolStart("bash", {});
      expect(buffer.buildStatusLine()).toBe("✅ read 🔧 bash");
    });

    it("appends ✍️ composing when streaming with no running tool", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onToolStart("read", {});
      buffer.onToolEnd("read", false);
      buffer.onTextDelta("hello");
      expect(buffer.buildStatusLine()).toBe("✅ read ✍️ composing");
    });

    it("hides ✍️ composing while a tool is still running", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onTextDelta("partial");
      buffer.onToolStart("bash", {});
      expect(buffer.buildStatusLine()).toBe("🔧 bash");
    });

    it("clears isStreaming on onAgentEnd", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onTextDelta("text");
      expect(buffer._state().isStreaming).toBe(true);
      buffer.onAgentEnd();
      expect(buffer._state().isStreaming).toBe(false);
      expect(buffer.buildStatusLine()).toBe("");
    });

    it("renders the design example: ✅ read 🔧 bash ✍️ composing", () => {
      const buffer = new MessageBuffer(makeBot(), 1);
      buffer.onToolStart("read", {});
      buffer.onToolEnd("read", false);
      buffer.onToolStart("bash", {});
      buffer.onTextDelta("partial");
      // bash is still running, so composing is suppressed by design.
      expect(buffer.buildStatusLine()).toBe("✅ read 🔧 bash");
      // Once bash completes, composing surfaces.
      buffer.onToolEnd("bash", false);
      expect(buffer.buildStatusLine()).toBe("✅ read ✅ bash ✍️ composing");
    });
  });
});
