import { describe, it, expect } from "bun:test";
import type { Bot } from "grammy";
import { MessageBuffer } from "./buffer.ts";

interface SendCall {
  chatId: number | string;
  text: string;
}
interface EditCall {
  chatId: number | string;
  messageId: number;
  text: string;
}

interface MockBot {
  bot: Bot;
  send: SendCall[];
  edit: EditCall[];
  /** Set to throw the next sendMessage / editMessageText. */
  failNext: { send?: unknown; edit?: unknown };
  nextMessageId: number;
}

function makeBot(): MockBot {
  const send: SendCall[] = [];
  const edit: EditCall[] = [];
  const state: MockBot = {
    bot: undefined as unknown as Bot,
    send,
    edit,
    failNext: {},
    nextMessageId: 100,
  };
  const bot = {
    api: {
      sendMessage: async (chatId: number | string, text: string) => {
        if (state.failNext.send !== undefined) {
          const err = state.failNext.send;
          state.failNext.send = undefined;
          throw err;
        }
        send.push({ chatId, text });
        return { message_id: ++state.nextMessageId };
      },
      editMessageText: async (
        chatId: number | string,
        messageId: number,
        text: string,
      ) => {
        if (state.failNext.edit !== undefined) {
          const err = state.failNext.edit;
          state.failNext.edit = undefined;
          throw err;
        }
        edit.push({ chatId, messageId, text });
        return true;
      },
    },
  } as unknown as Bot;
  state.bot = bot;
  return state;
}

/** Drain pending microtasks so fire-and-forget flushes settle. */
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("MessageBuffer", () => {
  it("instantiates with default visibility", () => {
    const { bot } = makeBot();
    const buffer = new MessageBuffer(bot, 123);
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
    const { bot } = makeBot();
    const buffer = new MessageBuffer(bot, 7, { visibility: "verbose" });
    expect(buffer._state().visibility).toBe("verbose");
  });

  it("exposes all TurnCallbacks methods without throwing", async () => {
    const { bot } = makeBot();
    const buffer = new MessageBuffer(bot, 1);
    expect(() => buffer.onTextDelta("hi")).not.toThrow();
    expect(() => buffer.onToolStart("bash", {})).not.toThrow();
    expect(() => buffer.onToolEnd("bash", false)).not.toThrow();
    expect(() => buffer.onStatusUpdate("thinking")).not.toThrow();
    expect(() => buffer.onAgentEnd()).not.toThrow();
    await tick();
  });

  describe("status line state machine", () => {
    it("renders empty string when no tool activity", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      expect(buffer.buildStatusLine()).toBe("");
    });

    it("marks a tool as running on onToolStart", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onToolStart("bash", { command: "ls" });
      expect(buffer.buildStatusLine()).toBe("🔧 bash");
      expect(buffer._state().toolStates.get("bash")).toBe("running");
    });

    it("transitions running → success on onToolEnd(false)", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onToolStart("bash", {});
      buffer.onToolEnd("bash", false);
      expect(buffer.buildStatusLine()).toBe("✅ bash");
      expect(buffer._state().toolStates.get("bash")).toBe("success");
    });

    it("transitions running → error on onToolEnd(true)", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onToolStart("bash", {});
      buffer.onToolEnd("bash", true);
      expect(buffer.buildStatusLine()).toBe("❌ bash");
      expect(buffer._state().toolStates.get("bash")).toBe("error");
    });

    it("preserves insertion order for multiple tools", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onToolStart("read", {});
      buffer.onToolEnd("read", false);
      buffer.onToolStart("bash", {});
      expect(buffer.buildStatusLine()).toBe("✅ read 🔧 bash");
    });

    it("appends ✍️ composing when streaming with no running tool", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onToolStart("read", {});
      buffer.onToolEnd("read", false);
      buffer.onTextDelta("hello");
      expect(buffer.buildStatusLine()).toBe("✅ read ✍️ composing");
    });

    it("hides ✍️ composing while a tool is still running", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onTextDelta("partial");
      buffer.onToolStart("bash", {});
      expect(buffer.buildStatusLine()).toBe("🔧 bash");
    });

    it("clears isStreaming on onAgentEnd", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1);
      buffer.onTextDelta("text");
      expect(buffer._state().isStreaming).toBe(true);
      buffer.onAgentEnd();
      expect(buffer._state().isStreaming).toBe(false);
      expect(buffer.buildStatusLine()).toBe("");
    });
  });

  describe("flushStatus throttle and Telegram I/O", () => {
    it("first flush sends a new message and tracks statusMessageId", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 42, { now: () => 1_000_000 });
      buffer.onToolStart("bash", {});
      await buffer.flushStatus();
      expect(m.send.length).toBe(1);
      expect(m.send[0]).toEqual({ chatId: 42, text: "🔧 bash" });
      expect(m.edit.length).toBe(0);
      expect(buffer._state().statusMessageId).toBe(101);
    });

    it("subsequent flushes edit the tracked message", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 42, { now: () => t });
      buffer.onToolStart("bash", {});
      await buffer.flushStatus();
      expect(m.send.length).toBe(1);

      t = 3000; // beyond throttle window
      buffer.onToolEnd("bash", false);
      await buffer.flushStatus();
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]).toEqual({
        chatId: 42,
        messageId: 101,
        text: "✅ bash",
      });
    });

    it("throttles edits inside the 1000ms window", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, { now: () => t });
      buffer.onToolStart("bash", {});
      await buffer.flushStatus();
      expect(m.send.length).toBe(1);

      t = 1500; // still inside 1000ms window
      buffer.onToolEnd("bash", false);
      await buffer.flushStatus();
      expect(m.edit.length).toBe(0);

      t = 2000; // window elapsed
      await buffer.flushStatus();
      expect(m.edit.length).toBe(1);
    });

    it("force=true bypasses throttle (used by onAgentEnd)", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, { now: () => t });
      buffer.onToolStart("bash", {});
      await buffer.flushStatus();
      expect(m.send.length).toBe(1);

      t = 1100;
      buffer.onToolEnd("bash", false);
      await buffer.flushStatus(true);
      expect(m.edit.length).toBe(1);
    });

    it("skips when status line is empty", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1);
      await buffer.flushStatus(true);
      expect(m.send.length).toBe(0);
      expect(m.edit.length).toBe(0);
    });

    it("handles 429 rate limit by logging and not setting statusMessageId", async () => {
      let t = 1000;
      const m = makeBot();
      m.failNext.send = { error_code: 429, description: "Too Many Requests" };
      const buffer = new MessageBuffer(m.bot, 1, { now: () => t });

      buffer.onToolStart("bash", {});
      await buffer.flushStatus();
      expect(buffer._state().statusMessageId).toBeUndefined();

      // After throttle window, next flush attempts sendMessage again.
      t = 3000;
      await buffer.flushStatus();
      expect(m.send.length).toBe(1);
    });

    it("handles deleted status message by resetting statusMessageId", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, { now: () => t });

      buffer.onToolStart("bash", {});
      await buffer.flushStatus();
      expect(buffer._state().statusMessageId).toBe(101);

      // User deletes the status message — next edit fails.
      t = 3000;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message to edit not found",
      };
      buffer.onToolEnd("bash", false);
      await buffer.flushStatus();
      expect(buffer._state().statusMessageId).toBeUndefined();

      // Next flush should send a fresh message.
      t = 5000;
      await buffer.flushStatus(true);
      expect(m.send.length).toBe(2);
      expect(m.send[1]?.text).toBe("✅ bash");
    });

    it("does not throw out of flushStatus on unknown errors", async () => {
      const m = makeBot();
      m.failNext.send = new Error("boom");
      const buffer = new MessageBuffer(m.bot, 1);
      buffer.onToolStart("bash", {});
      await expect(buffer.flushStatus()).resolves.toBeUndefined();
    });

    it("auto-flushes from callbacks (fire-and-forget)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1);
      buffer.onToolStart("bash", {});
      await tick();
      expect(m.send.length).toBe(1);
    });
  });
});
