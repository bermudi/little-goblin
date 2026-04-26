import { describe, it, expect } from "bun:test";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import {
  MessageBuffer,
  MAX_MESSAGE_LEN,
  BIG_OUTPUT_THRESHOLD,
  SUMMARY_PREFIX_LEN,
  findSafeSplit,
  shouldShowTool,
  VISIBILITY_TOOLS,
} from "./buffer.ts";

interface SendCall {
  chatId: number | string;
  text: string;
}
interface EditCall {
  chatId: number | string;
  messageId: number;
  text: string;
}
interface DocumentCall {
  chatId: number | string;
  filename: string | undefined;
  document: InputFile;
}

interface MockBot {
  bot: Bot;
  send: SendCall[];
  edit: EditCall[];
  documents: DocumentCall[];
  /** Set to throw the next sendMessage / editMessageText / sendDocument. */
  failNext: { send?: unknown; edit?: unknown; document?: unknown };
  nextMessageId: number;
}

function makeBot(): MockBot {
  const send: SendCall[] = [];
  const edit: EditCall[] = [];
  const documents: DocumentCall[] = [];
  const state: MockBot = {
    bot: undefined as unknown as Bot,
    send,
    edit,
    documents,
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
      sendDocument: async (chatId: number | string, document: InputFile) => {
        if (state.failNext.document !== undefined) {
          const err = state.failNext.document;
          state.failNext.document = undefined;
          throw err;
        }
        documents.push({ chatId, filename: document.filename, document });
        return { message_id: ++state.nextMessageId };
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

  describe("response streaming via flushResponse", () => {
    /**
     * These tests focus on response streaming behavior; we suppress the
     * status-line auto-flush by setting `statusThrottleMs` to a huge value,
     * so any sendMessage we observe is the response message.
     */
    const STATUS_OFF = Number.MAX_SAFE_INTEGER;

    it("accumulates text deltas in accumulatedText", () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        responseThrottleMs: 1_000_000,
        statusThrottleMs: STATUS_OFF,
      });
      buffer.onTextDelta("Hello, ");
      buffer.onTextDelta("world!");
      expect(buffer._state().accumulatedText).toBe("Hello, world!");
    });

    it("first flush sends a new response message and tracks responseMessageId", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 99, {
        now: () => 1000,
        statusThrottleMs: STATUS_OFF,
      });
      buffer.onTextDelta("Hello");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]).toEqual({ chatId: 99, text: "Hello" });
      expect(buffer._state().responseMessageId).toBe(101);
    });

    it("subsequent flushes edit the response message with full accumulated text", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        now: () => t,
        statusThrottleMs: STATUS_OFF,
      });

      buffer.onTextDelta("Hello");
      await tick();
      expect(m.send.length).toBe(1);

      t = 1500; // beyond 200ms throttle
      buffer.onTextDelta(", world!");
      await tick();
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]).toEqual({
        chatId: 1,
        messageId: 101,
        text: "Hello, world!",
      });
    });

    it("throttles response edits within ~200ms window", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        now: () => t,
        statusThrottleMs: STATUS_OFF,
      });

      buffer.onTextDelta("a");
      await tick();
      expect(m.send.length).toBe(1);

      t = 1100; // inside 200ms window
      buffer.onTextDelta("b");
      await tick();
      expect(m.edit.length).toBe(0);

      t = 1300; // window elapsed
      await buffer.flushResponse();
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]?.text).toBe("ab");
    });

    it("force=true bypasses response throttle (used by onAgentEnd)", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        now: () => t,
        statusThrottleMs: STATUS_OFF,
      });

      buffer.onTextDelta("a");
      await tick();
      expect(m.send.length).toBe(1);

      t = 1050; // well inside 200ms window
      buffer.onTextDelta("b");
      await buffer.flushResponse(true);
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]?.text).toBe("ab");
    });

    it("skips when accumulatedText is empty", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        statusThrottleMs: STATUS_OFF,
      });
      await buffer.flushResponse(true);
      expect(m.send.length).toBe(0);
      expect(m.edit.length).toBe(0);
    });

    it("handles deleted response message by resetting responseMessageId", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        now: () => t,
        statusThrottleMs: STATUS_OFF,
      });

      buffer.onTextDelta("hi");
      await tick();
      expect(buffer._state().responseMessageId).toBe(101);

      t = 1500;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message to edit not found",
      };
      buffer.onTextDelta("!");
      await tick();
      expect(buffer._state().responseMessageId).toBeUndefined();

      t = 2000;
      await buffer.flushResponse(true);
      expect(m.send.length).toBe(2);
      expect(m.send[1]?.text).toBe("hi!");
    });

    it("does not throw out of flushResponse on unknown errors", async () => {
      const m = makeBot();
      m.failNext.send = new Error("boom");
      const buffer = new MessageBuffer(m.bot, 1, {
        statusThrottleMs: STATUS_OFF,
      });
      buffer.onTextDelta("x");
      await expect(buffer.flushResponse()).resolves.toBeUndefined();
    });

    it("auto-flushes response from onTextDelta", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        statusThrottleMs: STATUS_OFF,
      });
      buffer.onTextDelta("auto");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text).toBe("auto");
    });

    it("onAgentEnd force-flushes the final response despite throttle", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        now: () => t,
        statusThrottleMs: STATUS_OFF,
      });
      buffer.onTextDelta("draft");
      await tick();
      expect(m.send.length).toBe(1);

      t = 1050; // well inside throttle
      buffer.onTextDelta(" more");
      buffer.onAgentEnd();
      await tick();
      const lastEdit = m.edit[m.edit.length - 1];
      expect(lastEdit?.text).toBe("draft more");
    });
  });

  describe("findSafeSplit (Unicode safety)", () => {
    it("returns text.length when text is shorter than maxLen", () => {
      expect(findSafeSplit("hi", 10)).toBe(2);
    });

    it("returns maxLen for plain ASCII at the boundary", () => {
      expect(findSafeSplit("a".repeat(20), 10)).toBe(10);
    });

    it("backs up by one when split would land mid-surrogate-pair", () => {
      // "😀" = U+1F600 → high surrogate 0xD83D + low surrogate 0xDE00.
      // Build: 9 ASCII chars + "😀" (2 code units) + 9 ASCII = length 20.
      const text = "a".repeat(9) + "😀" + "b".repeat(9);
      // maxLen=10 would slice [0..10), keeping the high surrogate at index 9
      // but cutting off the low surrogate at index 10. Back up to 9.
      expect(findSafeSplit(text, 10)).toBe(9);
      const head = text.slice(0, findSafeSplit(text, 10));
      // Head must not end on a lone high surrogate.
      const last = head.charCodeAt(head.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });

    it("does not back up when split is between full BMP characters", () => {
      // "😀" at the very start, ASCII rest. maxLen=10 sits in the ASCII
      // section, no surrogate to worry about.
      const text = "😀" + "a".repeat(20);
      expect(findSafeSplit(text, 10)).toBe(10);
    });
  });

  describe("4096 rollover via maybeRollover", () => {
    /**
     * Disable both auto-flushes so the rollover tests are driven entirely
     * by explicit `flushResponse(true)` calls. This avoids the race between
     * `onTextDelta`'s fire-and-forget flush and the test's explicit flush.
     */
    const ALL_OFF: Partial<{
      statusThrottleMs: number;
      responseThrottleMs: number;
    }> = {
      statusThrottleMs: Number.MAX_SAFE_INTEGER,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    it("does not roll over when accumulatedText fits", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      buffer.onTextDelta("a".repeat(MAX_MESSAGE_LEN));
      await buffer.flushResponse(true);
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text.length).toBe(MAX_MESSAGE_LEN);
      expect(buffer._state().accumulatedText.length).toBe(MAX_MESSAGE_LEN);
    });

    it("rolls over once when accumulatedText is just over the limit", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      // Pre-seed the response message id by sending a small chunk first.
      buffer.onTextDelta("seed");
      await buffer.flushResponse(true);
      expect(m.send.length).toBe(1);
      expect(buffer._state().responseMessageId).toBe(101);

      // Now grow well past the limit. The first 4096 chars become the head
      // (edit on msg 101); the remainder becomes a new message.
      const big = "x".repeat(MAX_MESSAGE_LEN + 100);
      buffer.onTextDelta(big);
      await buffer.flushResponse(true);

      // Head edit on msg 101 with 4096 chars.
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]?.messageId).toBe(101);
      expect(m.edit[0]?.text.length).toBe(MAX_MESSAGE_LEN);

      // Tail send with the overflow.
      expect(m.send.length).toBe(2);
      expect(m.send[1]?.text.length).toBe("seed".length + 100);
      expect(buffer._state().responseMessageId).toBe(102);
      expect(buffer._state().accumulatedText.length).toBe(
        "seed".length + 100,
      );
    });

    it("rolls over multiple times for very large accumulated text", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      // 8200 chars from a fresh buffer (no prior responseMessageId).
      const big = "y".repeat(MAX_MESSAGE_LEN * 2 + 8);
      buffer.onTextDelta(big);
      await buffer.flushResponse(true);

      // 3 messages: head1 (4096), head2 (4096), tail (8). All sends, no edits
      // since responseMessageId starts undefined.
      expect(m.edit.length).toBe(0);
      expect(m.send.length).toBe(3);
      expect(m.send[0]?.text.length).toBe(MAX_MESSAGE_LEN);
      expect(m.send[1]?.text.length).toBe(MAX_MESSAGE_LEN);
      expect(m.send[2]?.text.length).toBe(8);
      // The final tail message is the active responseMessageId.
      expect(buffer._state().responseMessageId).toBe(103);
      expect(buffer._state().accumulatedText.length).toBe(8);
    });

    it("preserves total content across rollovers", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      const total = "a".repeat(MAX_MESSAGE_LEN) + "b".repeat(MAX_MESSAGE_LEN) + "c".repeat(50);
      buffer.onTextDelta(total);
      await buffer.flushResponse(true);

      const reconstructed =
        m.send.map((s) => s.text).join("") + m.edit.map((e) => e.text).join("");
      // No edits in this scenario (no pre-existing message), so concatenation
      // of sends should equal the original.
      expect(reconstructed).toBe(total);
    });

    it("does not split a UTF-16 surrogate pair across messages", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      // Put an emoji ("😀" = 2 code units) right at the boundary.
      // Layout: (MAX_MESSAGE_LEN - 1) ASCII + emoji + filler.
      const head = "a".repeat(MAX_MESSAGE_LEN - 1);
      const text = head + "😀" + "b".repeat(50);
      buffer.onTextDelta(text);
      await buffer.flushResponse(true);

      // First message must end before the surrogate pair (length = 4095).
      expect(m.send[0]?.text.length).toBe(MAX_MESSAGE_LEN - 1);
      const last = m.send[0]!.text.charCodeAt(m.send[0]!.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      // The emoji should be at the start of the next message, intact.
      expect(m.send[1]?.text.startsWith("😀")).toBe(true);
    });

    it("subsequent edits target the new active message after rollover", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, {
        ...ALL_OFF,
        now: () => t,
      });
      buffer.onTextDelta("seed");
      await buffer.flushResponse(true);
      expect(buffer._state().responseMessageId).toBe(101);

      buffer.onTextDelta("x".repeat(MAX_MESSAGE_LEN + 10));
      t = 2000;
      await buffer.flushResponse(true);
      const newId = buffer._state().responseMessageId;
      expect(newId).toBe(102);

      // Append more; should edit msg 102, not 101.
      t = 3000;
      buffer.onTextDelta("after");
      await buffer.flushResponse(true);
      const lastEdit = m.edit[m.edit.length - 1];
      expect(lastEdit?.messageId).toBe(102);
    });
  });

  describe("big output file escape (>20KB)", () => {
    /** Disable both auto-flushes; drive via explicit `flushResponse(true)`. */
    const ALL_OFF = {
      statusThrottleMs: Number.MAX_SAFE_INTEGER,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    it("does not escape when text is at or below threshold", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      buffer.onTextDelta("a".repeat(BIG_OUTPUT_THRESHOLD));
      await buffer.flushResponse(true);
      expect(m.documents.length).toBe(0);
    });

    it("escapes >20KB text to reply.md attachment with summary", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 42, ALL_OFF);
      const big = "X".repeat(BIG_OUTPUT_THRESHOLD + 1000);
      buffer.onTextDelta(big);
      await buffer.flushResponse(true);

      // Document upload: filename is "reply.md", chatId matches.
      expect(m.documents.length).toBe(1);
      expect(m.documents[0]?.chatId).toBe(42);
      expect(m.documents[0]?.filename).toBe("reply.md");

      // Summary message: first 500 chars of the response + truncation suffix.
      expect(m.send.length).toBe(1);
      const expectedSummary =
        "X".repeat(SUMMARY_PREFIX_LEN) +
        "... [truncated, see attached reply.md]";
      expect(m.send[0]?.text).toBe(expectedSummary);

      // No rollover messages should fire.
      expect(m.edit.length).toBe(0);
    });

    it("clears state after file escape so future deltas start fresh", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      buffer.onTextDelta("Y".repeat(BIG_OUTPUT_THRESHOLD + 100));
      await buffer.flushResponse(true);

      const s = buffer._state();
      expect(s.accumulatedText).toBe("");
      expect(s.responseMessageId).toBeUndefined();

      // New deltas should land in a new message, not edit anything stale.
      buffer.onTextDelta("after");
      await buffer.flushResponse(true);
      const lastSend = m.send[m.send.length - 1];
      expect(lastSend?.text).toBe("after");
    });

    it("clears state even if sendDocument fails", async () => {
      const m = makeBot();
      m.failNext.document = new Error("network");
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      buffer.onTextDelta("Z".repeat(BIG_OUTPUT_THRESHOLD + 5));
      await buffer.flushResponse(true);

      const s = buffer._state();
      expect(s.accumulatedText).toBe("");
      expect(s.responseMessageId).toBeUndefined();
      expect(m.documents.length).toBe(0);
    });

    it("file escape pre-empts rollover (no 4096-message spam)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, ALL_OFF);
      // 50KB would otherwise produce ~12 rollover messages.
      buffer.onTextDelta("Q".repeat(50_000));
      await buffer.flushResponse(true);

      expect(m.documents.length).toBe(1);
      expect(m.send.length).toBe(1); // just the summary
      expect(m.edit.length).toBe(0);
    });
  });

  describe("tool visibility filtering", () => {
    describe("shouldShowTool", () => {
      it("none: hides every tool", () => {
        expect(shouldShowTool("bash", "none")).toBe(false);
        expect(shouldShowTool("read", "none")).toBe(false);
        expect(shouldShowTool("anything", "none")).toBe(false);
      });

      it("minimal: shows only state-changing α tools", () => {
        expect(shouldShowTool("bash", "minimal")).toBe(true);
        expect(shouldShowTool("write", "minimal")).toBe(true);
        expect(shouldShowTool("edit", "minimal")).toBe(true);
        expect(shouldShowTool("spawn_subagent", "minimal")).toBe(true);
        expect(shouldShowTool("read", "minimal")).toBe(false);
        expect(shouldShowTool("grep", "minimal")).toBe(false);
        expect(shouldShowTool("revive_subagent", "minimal")).toBe(false);
      });

      it("standard: shows all α tools (default)", () => {
        expect(shouldShowTool("bash", "standard")).toBe(true);
        expect(shouldShowTool("read", "standard")).toBe(true);
        expect(shouldShowTool("grep", "standard")).toBe(true);
        expect(shouldShowTool("revive_subagent", "standard")).toBe(false);
        expect(shouldShowTool("list_subagents", "standard")).toBe(false);
      });

      it("verbose: shows α + γ (subagent management) tools", () => {
        expect(shouldShowTool("bash", "verbose")).toBe(true);
        expect(shouldShowTool("read", "verbose")).toBe(true);
        expect(shouldShowTool("revive_subagent", "verbose")).toBe(true);
        expect(shouldShowTool("list_subagents", "verbose")).toBe(true);
        expect(shouldShowTool("some_internal_event", "verbose")).toBe(false);
      });

      it("debug: shows every tool, including unknown ones", () => {
        expect(shouldShowTool("bash", "debug")).toBe(true);
        expect(shouldShowTool("brand_new_tool", "debug")).toBe(true);
        expect(shouldShowTool("", "debug")).toBe(true);
      });

      it("unknown level falls back to standard", () => {
        expect(shouldShowTool("bash", "wat")).toBe(true);
        expect(shouldShowTool("revive_subagent", "wat")).toBe(false);
      });

      it("VISIBILITY_TOOLS table contains all five expected levels", () => {
        expect(Object.keys(VISIBILITY_TOOLS).sort()).toEqual([
          "debug",
          "minimal",
          "none",
          "standard",
          "verbose",
        ]);
      });
    });

    describe("MessageBuffer integration", () => {
      it("none visibility: no tool state, no status line, no flush", async () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, { visibility: "none" });
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", false);
        await tick();
        expect(buffer._state().toolStates.size).toBe(0);
        expect(buffer.buildStatusLine()).toBe("");
        expect(m.send.length).toBe(0);
        expect(m.edit.length).toBe(0);
      });

      it("none visibility: suppresses ✍️ composing too", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, { visibility: "none" });
        buffer.onTextDelta("hello");
        expect(buffer.buildStatusLine()).toBe("");
      });

      it("minimal visibility: bash visible, read filtered", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, {
          visibility: "minimal",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("read", {});
        buffer.onToolStart("bash", {});
        expect(buffer._state().toolStates.has("read")).toBe(false);
        expect(buffer._state().toolStates.has("bash")).toBe(true);
        expect(buffer.buildStatusLine()).toBe("🔧 bash");
      });

      it("standard visibility (default): read + bash both visible", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, {
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("read", {});
        buffer.onToolStart("bash", {});
        buffer.onToolStart("revive_subagent", {});
        expect(buffer._state().toolStates.has("read")).toBe(true);
        expect(buffer._state().toolStates.has("bash")).toBe(true);
        expect(buffer._state().toolStates.has("revive_subagent")).toBe(false);
      });

      it("verbose visibility: revive_subagent now visible", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, {
          visibility: "verbose",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("revive_subagent", {});
        expect(buffer._state().toolStates.has("revive_subagent")).toBe(true);
      });

      it("debug visibility: even unknown tools are shown", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, {
          visibility: "debug",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("brand_new_tool", {});
        expect(buffer._state().toolStates.has("brand_new_tool")).toBe(true);
        expect(buffer.buildStatusLine()).toBe("🔧 brand_new_tool");
      });

      it("filtering applies to onToolEnd as well", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, {
          visibility: "minimal",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        // read is filtered at start; ending it should not retroactively add it.
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        expect(buffer._state().toolStates.has("read")).toBe(false);
      });
    });
  });
});
