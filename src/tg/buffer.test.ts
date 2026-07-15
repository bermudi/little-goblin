import { describe, it, expect } from "bun:test";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import {
  MessageBuffer,
  MAX_MESSAGE_LEN,
  BIG_OUTPUT_THRESHOLD,
  SUMMARY_PREFIX_LEN,
  findSafeSplit,
  adjustForCodeSpan,
  shouldShowTool,
  VISIBILITY_TOOLS,
  VISIBILITY_LIMITS,
} from "./buffer.ts";

interface SendCall {
  chatId: number | string;
  text: string;
  opts?: Record<string, unknown>;
}
interface EditCall {
  chatId: number | string;
  messageId: number;
  text: string;
  opts?: Record<string, unknown>;
}
interface DocumentCall {
  chatId: number | string;
  filename: string | undefined;
  document: InputFile;
}
interface ChatActionCall {
  chatId: number | string;
  action: string;
}

interface MockBot {
  bot: Bot;
  send: SendCall[];
  edit: EditCall[];
  documents: DocumentCall[];
  chatActions: ChatActionCall[];
  /** Set to throw the next sendMessage / editMessageText / sendDocument. */
  failNext: {
    send?: unknown;
    edit?: unknown;
    document?: unknown;
    chatAction?: unknown;
  };
  nextMessageId: number;
}

function makeBot(): MockBot {
  const send: SendCall[] = [];
  const edit: EditCall[] = [];
  const documents: DocumentCall[] = [];
  const chatActions: ChatActionCall[] = [];
  const state: MockBot = {
    bot: undefined as unknown as Bot,
    send,
    edit,
    documents,
    chatActions,
    failNext: {},
    nextMessageId: 100,
  };
  const bot = {
    api: {
      sendMessage: async (chatId: number | string, text: string, opts?: Record<string, unknown>) => {
        if (state.failNext.send !== undefined) {
          const err = state.failNext.send;
          state.failNext.send = undefined;
          throw err;
        }
        send.push({ chatId, text, opts });
        return { message_id: ++state.nextMessageId };
      },
      editMessageText: async (
        chatId: number | string,
        messageId: number,
        text: string,
        opts?: Record<string, unknown>,
      ) => {
        if (state.failNext.edit !== undefined) {
          const err = state.failNext.edit;
          state.failNext.edit = undefined;
          throw err;
        }
        edit.push({ chatId, messageId, text, opts });
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
      sendChatAction: async (chatId: number | string, action: string) => {
        if (state.failNext.chatAction !== undefined) {
          const err = state.failNext.chatAction;
          state.failNext.chatAction = undefined;
          throw err;
        }
        chatActions.push({ chatId, action });
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
  it("instantiates with default visibility and empty slots", () => {
    const { bot } = makeBot();
    const buffer = new MessageBuffer(bot, 123, undefined);
    const s = buffer._state();
    expect(s.chatId).toBe(123);
    expect(s.visibility).toBe("standard");
    expect(s.statusMessageId).toBeUndefined();
    expect(s.responseMessageId).toBeUndefined();
    expect(s.accumulatedText).toBe("");
    expect(s.slots).toEqual([]);
    expect(s.placeholderSent).toBe(false);
    expect(s.statusFrozen).toBe(false);
    expect(s.lastEditTime).toBe(0);
    expect(s.isStreaming).toBe(false);
  });

  it("respects visibility option", () => {
    const { bot } = makeBot();
    const buffer = new MessageBuffer(bot, 7, undefined, { visibility: "verbose" });
    expect(buffer._state().visibility).toBe("verbose");
  });

  it("exposes all TurnCallbacks methods without throwing", async () => {
    const { bot } = makeBot();
    const buffer = new MessageBuffer(bot, 1, undefined);
    expect(() => buffer.onTextDelta("hi")).not.toThrow();
    expect(() => buffer.onToolStart("bash", {})).not.toThrow();
    expect(() => buffer.onToolEnd("bash", false)).not.toThrow();
    expect(() => buffer.onStatusUpdate("thinking")).not.toThrow();
    expect(() => buffer.onAgentEnd()).not.toThrow();
    await tick();
  });

  describe("status phase state machine", () => {
    /**
     * Pure state-and-render tests. Auto-flush is suppressed so we don't
     * accidentally observe placeholder/transition writes; the dedicated
     * "eager placeholder" and "phase transitions trigger ≤3 writes"
     * blocks below cover the Telegram I/O.
     */
    const NO_AUTO = {
      statusThrottleMs: Number.MAX_SAFE_INTEGER,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    describe("buildStatusLine rendering", () => {
      it("renders empty string before placeholder and slots", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        // No placeholder sent, no slots — nothing to render.
        expect(buffer.buildStatusLine()).toBe("");
      });

      it("renders header when placeholder has been sent", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        // Simulate placeholder sent via commitStatus (which is suppressed by
        // the NO_AUTO throttle — but placeholderSent is set by onStatusUpdate).
        buffer.onStatusUpdate("thinking...");
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…");
      });

      it("renders header + running slot when a tool starts", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash");
      });

      it("renders header + ok slot when a tool completes", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash");
      });

      it("renders header + err slot when a tool errors", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", true);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n❌ bash");
      });

      it("renders multiple tools each on their own line in observation order", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolStart("read", {});
        buffer.onToolEnd("bash", false);
        buffer.onToolEnd("read", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash\n✅ read");
      });

      it("renders mixed success/error independently per slot", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolStart("read", {});
        buffer.onToolEnd("bash", true);
        buffer.onToolEnd("read", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n❌ bash\n✅ read");
      });

      it("folds repeat invocations with ×N count", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ read ×3");
      });

      it("re-entry from ok back to running increments count", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        // Second invocation starts — slot goes back to running.
        buffer.onToolStart("read", {});
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 read ×2");
      });

      it("parallel invocations stay running until all ends arrive", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolStart("bash", {});
        // One end: runningCount drops to 1, still running.
        buffer.onToolEnd("bash", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash ×2");
        // Second end: runningCount hits 0, transitions to ok.
        buffer.onToolEnd("bash", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash ×2");
      });

      it("mixed success and error uses latest completed outcome", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", true);
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ read ×2");
      });

      it("retry trajectory renders successful final edit after earlier failures", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("edit", {});
        buffer.onToolEnd("edit", true);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n❌ edit");
        buffer.onToolStart("edit", {});
        buffer.onToolEnd("edit", true);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n❌ edit ×2");
        buffer.onToolStart("edit", {});
        buffer.onToolEnd("edit", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ edit ×3");
      });

      it("renders empty string in none visibility (any state)", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, {
          ...NO_AUTO,
          visibility: "none",
        });
        expect(buffer.buildStatusLine()).toBe("");
        buffer.onToolStart("bash", {}); // filtered out entirely
        expect(buffer.buildStatusLine()).toBe("");
      });

      it("zero-tool turn with placeholder sent renders header only", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onStatusUpdate("thinking...");
        buffer.onAgentEnd();
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…");
      });

      it("zero-tool turn with no placeholder renders empty", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onAgentEnd();
        expect(buffer.buildStatusLine()).toBe("");
      });

      it("✍️ composing indicator is gone (chat_action covers liveness)", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onTextDelta("hello");
        expect(buffer.buildStatusLine()).not.toContain("composing");
        expect(buffer.buildStatusLine()).not.toContain("✍️");
      });

      it("header persists across slot transitions", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash");
        buffer.onToolEnd("bash", false);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash");
      });

      it("filtered tool produces no slot", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, {
          ...NO_AUTO,
          visibility: "minimal",
        });
        buffer.onToolStart("read", {}); // filtered
        buffer.onToolStart("bash", {});  // visible
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash");
      });
    });

    describe("slot state transitions", () => {
      it("first onToolStart creates a running slot", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        expect(buffer._state().slots).toEqual([]);
        buffer.onToolStart("bash", {});
        const slots = buffer._state().slots;
        expect(slots.length).toBe(1);
        expect(slots[0]![0]).toBe("bash");
        expect(slots[0]![1].runningCount).toBe(1);
        expect(slots[0]![1].completedCount).toBe(0);
        expect(slots[0]![1].lastCompletedError).toBe(false);
      });

      it("subsequent onToolStart for different tools create separate slots", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolStart("read", {});
        const slotNames = buffer._state().slots.map(([n]) => n);
        expect(slotNames).toEqual(["bash", "read"]);
      });

      it("repeated onToolStart for the same tool increments runningCount", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolStart("bash", {});
        const slot = buffer._state().slots[0]![1];
        expect(slot.runningCount).toBe(2);
      });

      it("onToolEnd decrements runningCount and increments completedCount", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", false);
        const slot = buffer._state().slots[0]![1];
        expect(slot.runningCount).toBe(0);
        expect(slot.completedCount).toBe(1);
        expect(slot.endedAt).toBeDefined();
      });

      it("parallel invocations: slot stays running until runningCount hits zero", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", false);
        const slot = buffer._state().slots[0]![1];
        expect(slot.runningCount).toBe(1);
        expect(slot.completedCount).toBe(1);
        // Still running
        buffer.onToolEnd("bash", false);
        expect(slot.runningCount).toBe(0);
        expect(slot.completedCount).toBe(2);
      });

      it("error sets lastCompletedError on the slot", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", true);
        const slot = buffer._state().slots[0]![1];
        expect(slot.lastCompletedError).toBe(true);
        expect(slot.completedCount).toBe(1);
      });

      it("filtered tools do not produce a slot", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, {
          ...NO_AUTO,
          visibility: "minimal",
        });
        buffer.onToolStart("read", {});
        buffer.onToolStart("bash", {});
        const slotNames = buffer._state().slots.map(([n]) => n);
        expect(slotNames).toEqual(["bash"]);
      });

      it("onAgentEnd freezes the status", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onAgentEnd();
        expect(buffer._state().statusFrozen).toBe(true);
      });

      it("onAgentEnd leaves running slots as-is (still running)", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        // Tool never ended; agent ends anyway.
        buffer.onAgentEnd();
        const slot = buffer._state().slots[0]![1];
        expect(slot.runningCount).toBe(1);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash");
      });

      it("clears isStreaming on onAgentEnd", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onTextDelta("text");
        expect(buffer._state().isStreaming).toBe(true);
        buffer.onAgentEnd();
        expect(buffer._state().isStreaming).toBe(false);
      });

      it("onTextDelta does not change slot state", () => {
        const { bot } = makeBot();
        const buffer = new MessageBuffer(bot, 1, undefined, NO_AUTO);
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", false);
        buffer.onTextDelta("answer");
        // Slot is still ✅ — text deltas don't touch slots.
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash");
      });
    });
  });

  describe("eager placeholder via onStatusUpdate", () => {
    it("sends the thinking placeholder on first onStatusUpdate", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 7, undefined);
      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]).toEqual({ chatId: 7, text: "🤔 thinking…", opts: {} });
      expect(buffer._state().placeholderSent).toBe(true);
      expect(buffer._state().statusMessageId).toBe(101);
    });

    it("is idempotent — repeated onStatusUpdate does not resend", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onStatusUpdate("a");
      await tick();
      buffer.onStatusUpdate("b");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.edit.length).toBe(0);
    });

    it("none visibility suppresses the placeholder entirely", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, { visibility: "none" });
      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(m.send.length).toBe(0);
      expect(buffer._state().placeholderSent).toBe(false);
    });

    it("placeholder is sent before any response message", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      // Real AgentRunner ordering: agent_start (→ onStatusUpdate) then text.
      buffer.onStatusUpdate("thinking...");
      buffer.onTextDelta("hello");
      await tick();
      await tick();
      // First send is the status placeholder; second is the response.
      expect(m.send.length).toBeGreaterThanOrEqual(2);
      expect(m.send[0]?.text).toBe("🤔 thinking…");
      expect(m.send[1]?.text).toBe("hello");
    });

    it("does NOT send placeholder on first onTextDelta — only onStatusUpdate or onToolStart trigger it", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onTextDelta("hi");
      await tick();
      // Only the response message is sent; no status placeholder.
      const texts = m.send.map((s) => s.text);
      expect(texts).not.toContain("🤔 thinking…");
      expect(texts).toContain("hi");
      expect(buffer._state().placeholderSent).toBe(false);
    });

    it("sends placeholder on first onToolStart if no onStatusUpdate fired", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onToolStart("bash", {});
      await tick();
      // One send: the slot model renders header + running slot.
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text).toBe("🤔 thinking…\n🔧 bash");
      expect(buffer._state().placeholderSent).toBe(true);
    });
  });

  describe("flushStatus phase-driven I/O", () => {
    it("typical turn coalesces via throttle and in-flight dedupe", async () => {
      // Typical agent flow: agent_start → 4 tool starts → 4 tool ends → text → end.
      // The slot model should coalesce rapid state changes into few writes.
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);

      buffer.onStatusUpdate("thinking...");
      await tick();

      buffer.onToolStart("bash", {});
      buffer.onToolStart("read", {});
      buffer.onToolStart("write", {});
      buffer.onToolStart("grep", {});
      await tick();

      buffer.onToolEnd("bash", false);
      buffer.onToolEnd("read", false);
      buffer.onToolEnd("write", false);
      buffer.onToolEnd("grep", false);
      await tick();

      buffer.onTextDelta("done");
      buffer.onAgentEnd();
      await tick();

      // Count status-related writes (sends + edits starting with status icons).
      const statusSends = m.send.filter(
        (s) =>
          s.text.startsWith("🤔") ||
          s.text.startsWith("🔧") ||
          s.text.startsWith("✅") ||
          s.text.startsWith("❌"),
      ).length;
      const statusEdits = m.edit.filter(
        (e) =>
          e.text.startsWith("🤔") ||
          e.text.startsWith("🔧") ||
          e.text.startsWith("✅") ||
          e.text.startsWith("❌"),
      ).length;
      // Worst case: 2T + 2 = 10 for T=4. Coalescing should be well under that.
      expect(statusSends + statusEdits).toBeLessThanOrEqual(10);
      expect(statusSends + statusEdits).toBeGreaterThan(0);
    });

    it("many sequential tools coalesce via throttle and in-flight dedupe", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);

      buffer.onStatusUpdate("thinking...");
      await tick();
      const sendsAfterPlaceholder = m.send.length;
      const editsAfterPlaceholder = m.edit.length;

      // Fire 4 tool starts; only the first triggers a transition.
      buffer.onToolStart("bash", {});
      buffer.onToolStart("read", {});
      buffer.onToolStart("write", {});
      buffer.onToolStart("grep", {});
      await tick();

      // After 4 onToolStart calls, exactly one new write happened (the
      // working transition). No further sends; the working-phase edit is
      // a single editMessageText.
      const newSends = m.send.length - sendsAfterPlaceholder;
      const newEdits = m.edit.length - editsAfterPlaceholder;
      expect(newSends + newEdits).toBe(1);
    });

    it("first phase-driven flush sends and tracks statusMessageId", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 42, undefined);
      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.chatId).toBe(42);
      expect(buffer._state().statusMessageId).toBe(101);
    });

    it("phase transitions edit the tracked message", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 42, undefined, { now: () => t });
      buffer.onStatusUpdate("thinking...");
      await tick();

      t = 3000; // beyond status throttle (force=true bypasses it anyway)
      buffer.onToolStart("bash", {});
      await tick();
      // Working transition: edit the placeholder message in place.
      expect(m.edit.length).toBeGreaterThanOrEqual(1);
      const lastEdit = m.edit[m.edit.length - 1];
      expect(lastEdit?.messageId).toBe(101);
      expect(lastEdit?.text).toBe("🤔 thinking…\n🔧 bash");
    });

    it("statusFrozen blocks any further edits after onAgentEnd", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onStatusUpdate("thinking...");
      await tick();
      buffer.onToolStart("bash", {});
      await tick();
      buffer.onToolEnd("bash", false);
      await tick();
      buffer.onAgentEnd();
      await tick();
      const writesBeforeStrayEvents = m.send.length + m.edit.length;

      // Stray events arriving post-end (e.g. a delayed tool_execution_end)
      // SHALL NOT cause additional edits.
      await buffer.flushStatus(true);
      buffer.onToolStart("late", {});
      buffer.onToolEnd("late", false);
      await buffer.flushStatus(true);
      await tick();

      expect(m.send.length + m.edit.length).toBe(writesBeforeStrayEvents);
      expect(buffer._state().statusFrozen).toBe(true);
    });

    it("stray onToolStart after onAgentEnd does not flush response (force-flush IIFE bypass)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onTextDelta("residual text that arrived late");
      await tick();
      buffer.onAgentEnd();
      await tick();
      const writesBeforeStray = m.send.length + m.edit.length;

      // A stray onToolStart after onAgentEnd would previously trigger the
      // force-flush IIFE (flushResponse(true)), bypassing the freeze since
      // flushResponse has no statusFrozen check. The guard at the top of
      // onToolStart now prevents this.
      buffer.onToolStart("late", {});
      await tick();
      await buffer.flushResponse(true);
      await tick();

      expect(m.send.length + m.edit.length).toBe(writesBeforeStray);
      expect(buffer._state().statusFrozen).toBe(true);
    });

    it("force=true bypasses throttle (used by onAgentEnd)", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, { now: () => t });
      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(m.send.length).toBe(1);

      // Within the throttle window — without force, the next edit would
      // be skipped. The Working transition uses force=true.
      t = 1100;
      buffer.onToolStart("bash", {});
      await tick();
      expect(m.edit.length).toBe(1);
    });

    it("skips when status line is empty (none visibility, no force)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, { visibility: "none" });
      await buffer.flushStatus(true);
      expect(m.send.length).toBe(0);
      expect(m.edit.length).toBe(0);
    });

    it("handles 429 rate limit by logging and not setting statusMessageId", async () => {
      const m = makeBot();
      m.failNext.send = { error_code: 429, description: "Too Many Requests" };
      const buffer = new MessageBuffer(m.bot, 1, undefined);

      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(buffer._state().statusMessageId).toBeUndefined();
      expect(m.send.length).toBe(0); // nothing tracked because send threw
    });

    it("handles deleted status message by resetting statusMessageId", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, { now: () => t });

      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(buffer._state().statusMessageId).toBe(101);

      // User deletes the status message — next edit fails.
      t = 3000;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message to edit not found",
      };
      buffer.onToolStart("bash", {});
      await tick();
      expect(buffer._state().statusMessageId).toBeUndefined();
    });

    it("does not throw out of flushStatus on unknown errors", async () => {
      const m = makeBot();
      m.failNext.send = new Error("boom");
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onStatusUpdate("thinking...");
      await expect(buffer.flushStatus()).resolves.toBeUndefined();
    });

    it("auto-flushes from callbacks (fire-and-forget)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      buffer.onStatusUpdate("thinking...");
      await tick();
      expect(m.send.length).toBe(1);
    });

    it("zero-tool turn: agent_end with no tools observed sends nothing", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined);
      // No onStatusUpdate, no onToolStart — just an immediate end.
      buffer.onAgentEnd();
      await tick();
      // No placeholder sent, no slots — nothing to render.
      expect(m.send.length).toBe(0);
      expect(m.edit.length).toBe(0);
    });
  });

  describe("response streaming via flushResponse", () => {
    /**
     * These tests focus on response streaming behavior. We suppress the
     * status side entirely with `visibility: "none"` (force=true flushes
     * inside `commitStatus` would otherwise bypass any throttle setting),
     * so any sendMessage we observe is the response message.
     *
     * `responseThrottleMs: 200` pins the throttle to the historical default;
     * production now uses 1100ms (~1/sec) but these tests assert behavior
     * around a 200ms window. Tests that need a near-infinite throttle still
     * override explicitly.
     */
    const STATUS_OFF = { visibility: "none" as const, responseThrottleMs: 200 };

    it("accumulates text deltas in accumulatedText", () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        ...STATUS_OFF,
      });
      buffer.onTextDelta("Hello, ");
      buffer.onTextDelta("world!");
      expect(buffer._state().accumulatedText).toBe("Hello, world!");
    });

    it("first flush sends a new response message and tracks responseMessageId", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 99, undefined, {
        now: () => 1000,
        ...STATUS_OFF,
      });
      buffer.onTextDelta("Hello");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]).toEqual({ chatId: 99, text: "Hello", opts: { parse_mode: "MarkdownV2" } });
      expect(buffer._state().responseMessageId).toBe(101);
    });

    it("subsequent flushes edit the response message with full accumulated text", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
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
        opts: { parse_mode: "MarkdownV2" },
      });
    });

    it("throttles response edits within ~200ms window", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        ...STATUS_OFF,
      });
      await buffer.flushResponse(true);
      expect(m.send.length).toBe(0);
      expect(m.edit.length).toBe(0);
    });

    it("skips a no-op edit when text is unchanged since the last successful render", async () => {
      // Regression: agent_end's force-flush after the last delta already
      // landed would otherwise hit Telegram with the same text and earn
      // a 400 "message is not modified" warning. The local guard now
      // turns this into a no-op.
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });
      buffer.onTextDelta("hello");
      await tick();
      expect(m.send.length).toBe(1); // initial sendMessage

      t = 2000; // beyond throttle so a second flush would actually issue
      // No new delta; text is unchanged. Force-flush should be a no-op.
      await buffer.flushResponse(true);
      expect(m.edit.length).toBe(0);

      // After a real new delta, the edit fires as normal.
      buffer.onTextDelta(" world");
      await tick();
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]?.text).toBe("hello world");

      // And one more force-flush after that lands as a no-op too.
      t = 3000;
      await buffer.flushResponse(true);
      expect(m.edit.length).toBe(1);
    });

    it("downgrades 400 'message is not modified' to a debug log (no warn)", async () => {
      // Belt-and-braces for the guard above: even if a duplicate edit
      // slips through (e.g. concurrent flushes both reading the same
      // accumulatedText), Telegram's 400 must not be reported as a flush
      // failure. Verified indirectly: the API call happens, the buffer
      // stays usable, no error throws out.
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });
      buffer.onTextDelta("hi");
      await tick();
      expect(m.send.length).toBe(1);

      t = 2000;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      };
      // Force a different text so the local guard doesn't short-circuit;
      // we want the API call to actually happen and the 400 to be handled.
      buffer.onTextDelta("!");
      await tick();
      // Buffer survives, responseMessageId still set (not "message gone").
      expect(buffer._state().responseMessageId).toBe(101);
    });

    it("handles deleted response message by resetting responseMessageId", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
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

    it("recovers from a deleted response message on the final agent-end flush", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      buffer.onTextDelta("draft");
      await tick();
      expect(buffer._state().responseMessageId).toBe(101);

      t = 1050;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message to edit not found",
      };
      buffer.onTextDelta(" final");
      buffer.onAgentEnd();
      await tick();
      await tick();

      expect(m.send.length).toBe(2);
      expect(m.send[1]?.text).toBe("draft final");
      expect(buffer._state().responseMessageId).toBe(102);
      expect(buffer._state().isStreaming).toBe(false);
    });

    it("keeps the response message after a mid-stream 429 and retries latest text after backoff", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      buffer.onTextDelta("hi");
      await tick();
      expect(buffer._state().responseMessageId).toBe(101);

      t = 1500;
      m.failNext.edit = {
        error_code: 429,
        description: "Too Many Requests: retry later",
        parameters: { retry_after: 2 },
      };
      buffer.onTextDelta(" there");
      await tick();

      expect(buffer._state().responseMessageId).toBe(101);
      expect(buffer._state().lastResponseEditTime).toBe(3300);
      expect(m.edit.length).toBe(0);

      t = 2500;
      await buffer.flushResponse();
      expect(m.edit.length).toBe(0);

      t = 3600;
      buffer.onTextDelta("!");
      await tick();
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]?.text).toBe("hi there!");
    });

    it("survives an unknown mid-stream edit failure and finalizes with full text", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      buffer.onTextDelta("partial");
      await tick();
      expect(buffer._state().responseMessageId).toBe(101);

      t = 1500;
      m.failNext.edit = new Error("network down");
      buffer.onTextDelta(" after failure");
      await tick();
      expect(buffer._state().responseMessageId).toBe(101);
      expect(m.edit.length).toBe(0);

      t = 1600;
      buffer.onTextDelta(" done");
      buffer.onAgentEnd();
      await tick();
      await tick();

      const lastEdit = m.edit[m.edit.length - 1];
      expect(lastEdit?.messageId).toBe(101);
      expect(lastEdit?.text).toBe("partial after failure done");
      expect(buffer._state().isStreaming).toBe(false);
    });

    it("does not throw out of flushResponse on unknown errors", async () => {
      const m = makeBot();
      m.failNext.send = new Error("boom");
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        ...STATUS_OFF,
      });
      buffer.onTextDelta("x");
      await expect(buffer.flushResponse()).resolves.toBeUndefined();
    });

    it("calls onTopicNotFound when Telegram reports topic not found", async () => {
      let t = 1000;
      const m = makeBot();
      let callbackCalled = false;
      const buffer = new MessageBuffer(m.bot, 1, 42, {
        now: () => t,
        ...STATUS_OFF,
        onTopicNotFound: () => {
          callbackCalled = true;
        },
      });
      buffer.onTextDelta("hi");
      await tick();
      expect(m.send.length).toBe(1);

      // Next edit fails with "topic not found" — should trigger callback
      t += 500; // beyond 200ms throttle
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: topic not found",
      };
      buffer.onTextDelta("!");
      await tick();
      expect(callbackCalled).toBe(true);
    });

    it("calls onTopicNotFound only once even on multiple errors", async () => {
      let t = 1000;
      const m = makeBot();
      let callbackCount = 0;
      const buffer = new MessageBuffer(m.bot, 1, 42, {
        now: () => t,
        ...STATUS_OFF,
        onTopicNotFound: () => {
          callbackCount++;
        },
      });

      // First send succeeds to establish a message
      buffer.onTextDelta("first");
      await tick();
      expect(m.send.length).toBe(1);

      // Multiple edits fail with topic not found — callback only once
      t += 500;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message thread not found",
      };
      buffer.onTextDelta("second");
      await tick();

      t += 500;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: invalid message thread id",
      };
      buffer.onTextDelta("third");
      await tick();

      expect(callbackCount).toBe(1); // Only called once
    });

    it("does not call onTopicNotFound for non-topic errors", async () => {
      let t = 1000;
      const m = makeBot();
      let callbackCalled = false;
      const buffer = new MessageBuffer(m.bot, 1, 42, {
        now: () => t,
        ...STATUS_OFF,
        onTopicNotFound: () => {
          callbackCalled = true;
        },
      });

      // First send succeeds
      buffer.onTextDelta("test");
      await tick();
      expect(m.send.length).toBe(1);

      // Regular message not found should not trigger callback
      t += 500;
      m.failNext.edit = {
        error_code: 400,
        description: "Bad Request: message to edit not found",
      };
      buffer.onTextDelta("more");
      await tick();

      expect(callbackCalled).toBe(false);
    });

    it("auto-flushes response from onTextDelta", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        ...STATUS_OFF,
      });
      buffer.onTextDelta("auto");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text).toBe("auto");
    });

    it("does not duplicate-send when sendMessage is slower than the throttle window", async () => {
      // Regression: in production, Telegram's sendMessage often takes 100-300ms,
      // which is longer than the 200ms response-edit throttle. Without an
      // in-flight lock, a second flushResponse fires before the first
      // sendMessage has resolved, sees responseMessageId still undefined, and
      // sends a SECOND message — leaving an orphaned first message in chat.
      //
      // Repro from real session 2f03b2fe9e: the agent emitted "I'll" then a
      // long preamble; the user saw two response messages instead of one.
      const sends: { text: string }[] = [];
      const edits: { messageId: number; text: string }[] = [];
      let nextMessageId = 100;
      let releaseSend!: (msgId: number) => void;
      const sendPending: Promise<{ message_id: number }>[] = [];

      const bot = {
        api: {
          sendMessage: (_chatId: number, text: string) => {
            sends.push({ text });
            const p = new Promise<{ message_id: number }>((resolve) => {
              releaseSend = (id) => resolve({ message_id: id });
            });
            sendPending.push(p);
            return p;
          },
          editMessageText: async (
            _chatId: number,
            messageId: number,
            text: string,
          ) => {
            edits.push({ messageId, text });
            return true;
          },
          sendChatAction: async () => true,
        },
      } as unknown as Bot;

      let t = 1000;
      const buffer = new MessageBuffer(bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      // First delta: triggers sendMessage, which is "in flight" (not resolved).
      buffer.onTextDelta("I'll");
      await tick();
      expect(sends.length).toBe(1);
      expect(sends[0]?.text).toBe("I'll");

      // Time advances past the 200ms response throttle. More deltas arrive.
      // Without the in-flight guard, this would issue a second sendMessage.
      t = 1300;
      buffer.onTextDelta(" run a quick test");
      await tick();
      expect(sends.length).toBe(1); // <-- the bug would make this 2

      // Now release the first send. The buffer learns its responseMessageId.
      releaseSend(++nextMessageId);
      await tick();
      expect(buffer._state().responseMessageId).toBe(101);

      // Subsequent deltas should EDIT, not send.
      t = 1600;
      buffer.onTextDelta(".");
      await tick();
      expect(sends.length).toBe(1);
      expect(edits.length).toBeGreaterThanOrEqual(1);
      const lastEdit = edits[edits.length - 1];
      expect(lastEdit?.messageId).toBe(101);
      expect(lastEdit?.text).toBe("I'll run a quick test.");
    });

    it("agent_end force flush awaits in-flight edit, lands with FULL text (no truncation)", async () => {
      // Regression for real-world bug: during streaming, a delta-driven
      // editMessageText is in flight. Just before it returns, agent_end
      // fires and force-flushes. Without serialization, two concurrent
      // edits race and Telegram can process them in reverse order — the
      // user sees the partial mid-stream snapshot as the final text.
      // Repro: real session 2f03b2fe9e showed "...What" instead of the
      // full "...What else do you want to test?".
      let editCount = 0;
      const edits: { messageId: number; text: string }[] = [];
      let releaseEdit!: () => void;

      const bot = {
        api: {
          sendMessage: async (_c: number, _text: string) => {
            return { message_id: 200 };
          },
          editMessageText: (_c: number, messageId: number, text: string) => {
            const myCount = ++editCount;
            // First edit hangs until manually released; later edits resolve
            // immediately. This forces the second edit to be issued (or
            // not!) while the first is still in flight.
            return new Promise<true>((resolve) => {
              if (myCount === 1) {
                releaseEdit = () => {
                  edits.push({ messageId, text });
                  resolve(true);
                };
              } else {
                edits.push({ messageId, text });
                resolve(true);
              }
            });
          },
          sendChatAction: async () => true,
        },
      } as unknown as Bot;

      let t = 1000;
      const buffer = new MessageBuffer(bot, 1, undefined, {
        now: () => t,
        visibility: "none" as const,
        responseThrottleMs: 200,
      });

      // Send a delta to create the response message and trigger an edit.
      buffer.onTextDelta("partial");
      await tick();
      // The first edit's promise is hanging. responseMessageId is set.

      // Add more deltas; their flushes are throttled or serialized.
      t = 1100;
      buffer.onTextDelta(" more");
      buffer.onTextDelta(" stuff");
      buffer.onTextDelta(" arriving");
      await tick();

      // Agent ends while the first edit is still in flight. force=true
      // must NOT race a second edit; it must wait, then issue once with
      // the full accumulatedText.
      buffer.onAgentEnd();
      await tick();

      // Release the first edit. Serialization unblocks downstream.
      releaseEdit();
      await tick();
      await tick();
      await tick();

      // The LAST edit Telegram saw must contain the full accumulated text.
      const last = edits[edits.length - 1];
      expect(last?.text).toBe("partial more stuff arriving");
    });

    it("force-flush during in-flight send awaits and edits, never duplicates", async () => {
      // onAgentEnd uses force=true. If the initial sendMessage is still in
      // flight when agent_end fires, the force-flush must NOT race a second
      // sendMessage; it must wait for the first to resolve, then edit.
      const sends: string[] = [];
      const edits: { messageId: number; text: string }[] = [];
      let releaseSend!: (id: number) => void;

      const bot = {
        api: {
          sendMessage: (_chatId: number, text: string) => {
            sends.push(text);
            return new Promise<{ message_id: number }>((resolve) => {
              releaseSend = (id) => resolve({ message_id: id });
            });
          },
          editMessageText: async (
            _chatId: number,
            messageId: number,
            text: string,
          ) => {
            edits.push({ messageId, text });
            return true;
          },
          sendChatAction: async () => true,
        },
      } as unknown as Bot;

      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...STATUS_OFF,
      });

      buffer.onTextDelta("hello");
      await tick();
      expect(sends.length).toBe(1);

      // Agent ends while send is in flight. Append more text first so the
      // force-flush has something to edit.
      buffer.onTextDelta(" world");
      const endPromise = (async () => {
        buffer.onAgentEnd();
        await tick();
      })();

      // Release the initial send. The force-flush should now be unblocked
      // and edit the message instead of sending a second one.
      releaseSend(101);
      await endPromise;
      await tick();
      await tick();

      expect(sends.length).toBe(1);
      expect(edits.length).toBeGreaterThanOrEqual(1);
      const lastEdit = edits[edits.length - 1];
      expect(lastEdit?.messageId).toBe(101);
      expect(lastEdit?.text).toBe("hello world");
    });

    it("onAgentEnd force-flushes the final response despite throttle", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
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
    const ALL_OFF = {
      visibility: "none" as const,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    it("does not roll over when accumulatedText fits", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
      buffer.onTextDelta("a".repeat(MAX_MESSAGE_LEN));
      await buffer.flushResponse(true);
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text.length).toBe(MAX_MESSAGE_LEN);
      expect(buffer._state().accumulatedText.length).toBe(MAX_MESSAGE_LEN);
    });

    it("rolls over once when accumulatedText is just over the limit", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
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

    it("force flush waits for in-flight rollover and does not duplicate the tail", async () => {
      let releaseEdit!: () => void;
      const editGate = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      const send: SendCall[] = [];
      const edit: EditCall[] = [];
      let nextMessageId = 100;
      const bot = {
        api: {
          sendMessage: async (chatId: number | string, text: string) => {
            send.push({ chatId, text });
            return { message_id: ++nextMessageId };
          },
          editMessageText: async (
            chatId: number | string,
            messageId: number,
            text: string,
          ) => {
            await editGate;
            edit.push({ chatId, messageId, text });
            return true;
          },
          sendChatAction: async () => true,
        },
      } as unknown as Bot;
      const buffer = new MessageBuffer(bot, 1, undefined, ALL_OFF);

      buffer.onTextDelta("seed");
      await buffer.flushResponse(true);
      expect(buffer._state().responseMessageId).toBe(101);

      buffer.onTextDelta("x".repeat(MAX_MESSAGE_LEN + 10));
      const rollover = buffer.flushResponse(false);
      await tick();
      const final = buffer.flushResponse(true);
      await tick();

      expect(send.length).toBe(1);
      releaseEdit();
      await rollover;
      await final;

      expect(edit).toHaveLength(1);
      expect(send.map((s) => s.text)).toEqual([
        "seed",
        "x".repeat(14),
      ]);
      expect(buffer._state().responseMessageId).toBe(102);
    });
  });

  describe("big output file escape (>20KB)", () => {
    /** Disable both auto-flushes; drive via explicit `flushResponse(true)`. */
    const ALL_OFF = {
      visibility: "none" as const,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    it("does not escape when text is at or below threshold", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
      buffer.onTextDelta("a".repeat(BIG_OUTPUT_THRESHOLD));
      await buffer.flushResponse(true);
      expect(m.documents.length).toBe(0);
    });

    it("escapes >20KB text to reply.md attachment with summary", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 42, undefined, ALL_OFF);
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
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
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
      buffer.onTextDelta("Z".repeat(BIG_OUTPUT_THRESHOLD + 5));
      await buffer.flushResponse(true);

      const s = buffer._state();
      expect(s.accumulatedText).toBe("");
      expect(s.responseMessageId).toBeUndefined();
      expect(m.documents.length).toBe(0);
    });

    it("file escape pre-empts rollover (no 4096-message spam)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, ALL_OFF);
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
        expect(shouldShowTool("text_to_speech", "standard")).toBe(true);
        expect(shouldShowTool("revive_subagent", "standard")).toBe(false);
        expect(shouldShowTool("list_subagents", "standard")).toBe(false);
      });

      it("verbose: shows α + γ (subagent management) tools", () => {
        expect(shouldShowTool("bash", "verbose")).toBe(true);
        expect(shouldShowTool("read", "verbose")).toBe(true);
        expect(shouldShowTool("text_to_speech", "verbose")).toBe(true);
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
      it("none visibility: no slots, no status line, no flush", async () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, { visibility: "none" });
        buffer.onStatusUpdate("thinking...");
        buffer.onToolStart("bash", {});
        buffer.onToolEnd("bash", false);
        await tick();
        expect(buffer._state().slots).toEqual([]);
        expect(buffer.buildStatusLine()).toBe("");
        expect(m.send.length).toBe(0);
        expect(m.edit.length).toBe(0);
      });

      it("none visibility: suppresses status entirely on text deltas", async () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, { visibility: "none" });
        buffer.onTextDelta("hello");
        await tick();
        expect(buffer.buildStatusLine()).toBe("");
        // No status placeholder; only the response message.
        const statusSends = m.send.filter((s) =>
          s.text.startsWith("🤔") || s.text.startsWith("🔧"),
        );
        expect(statusSends.length).toBe(0);
      });

      it("minimal visibility: bash visible, read filtered", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, {
          visibility: "minimal",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("read", {});
        buffer.onToolStart("bash", {});
        const slotNames = buffer._state().slots.map(([n]: [string, unknown]) => n);
        expect(slotNames).toEqual(["bash"]);
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash");
      });

      it("standard visibility (default): read + bash both visible, γ filtered", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, {
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("read", {});
        buffer.onToolStart("bash", {});
        buffer.onToolStart("revive_subagent", {});
        const slotNames = buffer._state().slots.map(([n]: [string, unknown]) => n);
        expect(slotNames).toEqual(["read", "bash"]);
      });

      it("verbose visibility: revive_subagent now visible", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, {
          visibility: "verbose",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("revive_subagent", {});
        const slotNames = buffer._state().slots.map(([n]: [string, unknown]) => n);
        expect(slotNames).toContain("revive_subagent");
      });

      it("debug visibility: even unknown tools are shown", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, {
          visibility: "debug",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolStart("brand_new_tool", {});
        const slotNames = buffer._state().slots.map(([n]: [string, unknown]) => n);
        expect(slotNames).toContain("brand_new_tool");
        expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 brand_new_tool");
      });

      it("filtering applies to onToolEnd as well", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, {
          visibility: "minimal",
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        // read is filtered at start; ending it should not retroactively add it.
        buffer.onToolStart("read", {});
        buffer.onToolEnd("read", false);
        const slotNames = buffer._state().slots.map(([n]: [string, unknown]) => n);
        expect(slotNames).toEqual([]);
        // read slot was never created, so ending it is a no-op.
      });

      it("unmatched onToolEnd without prior onToolStart is a no-op", () => {
        const m = makeBot();
        const buffer = new MessageBuffer(m.bot, 1, undefined, {
          statusThrottleMs: Number.MAX_SAFE_INTEGER,
        });
        buffer.onToolEnd("bash", false);
        expect(buffer._state().slots).toEqual([]);
        expect(buffer.buildStatusLine()).toBe("");
      });
    });
  });

  describe("status slot cap per visibility level", () => {
    const NO_AUTO = {
      statusThrottleMs: Number.MAX_SAFE_INTEGER,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    it("VISIBILITY_TOOLS and VISIBILITY_LIMITS have parity on all keys", () => {
      const toolsKeys = Object.keys(VISIBILITY_TOOLS).sort();
      const limitsKeys = Object.keys(VISIBILITY_LIMITS).sort();
      expect(limitsKeys).toEqual(toolsKeys);
      for (const key of toolsKeys) {
        expect(VISIBILITY_LIMITS[key]).toBeDefined();
        expect(typeof VISIBILITY_LIMITS[key]!.cap).toBe("number");
        expect(typeof VISIBILITY_LIMITS[key]!.timing).toBe("boolean");
      }
    });

    it("under-cap renders all slots without footer", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, { ...NO_AUTO, visibility: "debug" });
      // debug cap is 25; create 5 completed tools.
      for (let i = 0; i < 5; i++) {
        buffer.onToolStart(`tool_${i}`, {});
        buffer.onToolEnd(`tool_${i}`, false);
      }
      const status = buffer.buildStatusLine();
      expect(status).not.toContain("earlier");
      // Header + 5 slots
      const lines = status.split("\n");
      expect(lines.length).toBe(6);
    });

    it("over cap elides oldest completed slots", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, { ...NO_AUTO, visibility: "debug", now: () => t });
      // debug cap is 25; create 30 completed tools.
      for (let i = 0; i < 30; i++) {
        buffer.onToolStart(`tool_${i}`, {});
        t += 100;
        buffer.onToolEnd(`tool_${i}`, false);
      }
      const status = buffer.buildStatusLine();
      const lines = status.split("\n");
      // Header + 25 kept slots + footer
      expect(lines.length).toBe(27);
      expect(lines[lines.length - 1]).toBe("… +5 earlier");
      // First kept slot should be tool_5 (tools 0-4 elided)
      expect(lines[1]).toBe("✅ tool_5 (0.1s)");
    });

    it("running slots are exempt from elision", () => {
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, { ...NO_AUTO, visibility: "debug" });
      // debug cap is 25. Create 26 tools, with the very oldest still running.
      buffer.onToolStart("oldest", {}); // still running — never ends
      for (let i = 1; i < 26; i++) {
        buffer.onToolStart(`tool_${i}`, {});
        buffer.onToolEnd(`tool_${i}`, false);
      }
      const status = buffer.buildStatusLine();
      const lines = status.split("\n");
      // "oldest" is running and must be present.
      expect(lines.some((l) => l.includes("oldest"))).toBe(true);
      expect(status).toContain("… +1 earlier");
    });

    it("multi-running scenario: 16 running + 16 completed at debug cap 25", () => {
      // We need a visibility where cap=12 AND arbitrary tool names are accepted.
      // Standard has cap=12 but only accepts 6 specific tool names.
      // Debug has cap=25 and accepts all names. Use standard tool names repeated
      // won't work (they fold). So use a test that works with debug cap=25.
      // 16 running + 16 completed = 32 total, cap 25.
      // 16 running exempt. 16 completed, cap allows 25 - 16 = 9 completed kept.
      // 7 completed elided.
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, { ...NO_AUTO, visibility: "debug" });
      for (let i = 0; i < 16; i++) {
        buffer.onToolStart(`run_${i}`, {}); // stay running
      }
      for (let i = 0; i < 16; i++) {
        buffer.onToolStart(`done_${i}`, {});
        buffer.onToolEnd(`done_${i}`, false);
      }
      const status = buffer.buildStatusLine();
      const lines = status.split("\n");
      // Header + 16 running + 9 kept completed + footer
      expect(lines.length).toBe(27); // 1 + 16 + 9 + 1
      expect(lines[lines.length - 1]).toBe("… +7 earlier");
      // All 16 running slots should be present
      const runningLines = lines.filter((l) => l.startsWith("🔧"));
      expect(runningLines.length).toBe(16);
      // 9 completed kept
      const completedLines = lines.filter((l) => l.startsWith("✅"));
      expect(completedLines.length).toBe(9);
    });
  });

  describe("per-tool elapsed timing for verbose and debug", () => {
    const NO_AUTO = {
      statusThrottleMs: Number.MAX_SAFE_INTEGER,
      responseThrottleMs: Number.MAX_SAFE_INTEGER,
    };

    it("verbose renders timing on completed slots", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...NO_AUTO,
        visibility: "verbose",
        now: () => t,
      });
      buffer.onToolStart("bash", {});
      t = 3130; // 2.13s later
      buffer.onToolEnd("bash", false);
      expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash (2.1s)");
    });

    it("standard does not render timing", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...NO_AUTO,
        visibility: "standard",
        now: () => t,
      });
      buffer.onToolStart("bash", {});
      t = 3130;
      buffer.onToolEnd("bash", false);
      expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash");
    });

    it("running slot has no timing under verbose", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...NO_AUTO,
        visibility: "verbose",
        now: () => t,
      });
      buffer.onToolStart("bash", {});
      t = 5000; // time passes but tool still running
      expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n🔧 bash");
    });

    it("debug renders timing like verbose", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...NO_AUTO,
        visibility: "debug",
        now: () => t,
      });
      buffer.onToolStart("my_tool", {});
      t = 3500;
      buffer.onToolEnd("my_tool", false);
      expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ my_tool (2.5s)");
    });

    it("re-entered slot timing reflects most recent invocation only", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...NO_AUTO,
        visibility: "verbose",
        now: () => t,
      });
      // First invocation: 2s
      buffer.onToolStart("bash", {});
      t = 3000;
      buffer.onToolEnd("bash", false);
      // Second invocation: 0.5s (startedAt resets, endedAt overwrites)
      t = 4000;
      buffer.onToolStart("bash", {});
      t = 4500;
      buffer.onToolEnd("bash", false);
      expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n✅ bash ×2 (0.5s)");
    });

    it("error slot also gets timing", () => {
      let t = 1000;
      const { bot } = makeBot();
      const buffer = new MessageBuffer(bot, 1, undefined, {
        ...NO_AUTO,
        visibility: "verbose",
        now: () => t,
      });
      buffer.onToolStart("bash", {});
      t = 2100;
      buffer.onToolEnd("bash", true);
      expect(buffer.buildStatusLine()).toBe("🤔 thinking…\n❌ bash (1.1s)");
    });
  });

  describe("response flush before tool execution", () => {
    const STATUS_OFF = { visibility: "none" as const, responseThrottleMs: 200 };

    it("force-flushes accumulated text when a tool starts", async () => {
      // Regression: LLM streams "Let me check the pi docs..." then calls a
      // tool. Without the fix, only the prefix that made it through the
      // throttle (e.g. "Let") is visible during tool execution. The user
      // sees "Let" for seconds until the tool finishes and more text arrives.
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      // First delta creates the response message.
      buffer.onTextDelta("Let");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text).toBe("Let");

      // More deltas arrive within the throttle window — they accumulate but
      // don't trigger a flush yet.
      t = 1100;
      buffer.onTextDelta(" me check the pi docs...");
      // Still within 200ms throttle, so no edit yet.
      expect(m.edit.length).toBe(0);

      // Now a tool starts. The fix force-flushes ALL accumulated text.
      buffer.onToolStart("read", {});
      await tick();

      // The response message should now show the FULL text.
      expect(m.edit.length).toBe(1);
      expect(m.edit[0]?.text).toBe("Let me check the pi docs...");
    });

    it("flushes even for filtered (hidden) tools", async () => {
      // In minimal visibility, "read" is hidden. The response flush must
      // still fire — it's about the response text, not the status line.
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        visibility: "minimal",
        responseThrottleMs: 200,
      });

      // First delta: triggers sendMessage. Second delta within throttle:
      // accumulated but not yet flushed. The toolStart force-flush is
      // what we're verifying — without it the second delta would only
      // land at the next throttle tick.
      buffer.onTextDelta("Checking ");
      await tick();
      expect(m.send.length).toBeGreaterThanOrEqual(1);
      buffer.onTextDelta("something");
      // Still within 200ms throttle, so no edit yet.
      const editsBefore = m.edit.length;

      // "read" is filtered in minimal visibility.
      buffer.onToolStart("read", {});
      await tick();

      // Status line should NOT mention "read".
      const slotNames = buffer._state().slots.map(([n]: [string, unknown]) => n);
      expect(slotNames).toEqual([]);
      // But the response message must have the full text flushed.
      const responseEdits = m.edit
        .slice(editsBefore)
        .filter((e) => !e.text.startsWith("🤔") && !e.text.startsWith("🔧"));
      expect(responseEdits.length).toBeGreaterThanOrEqual(1);
      expect(responseEdits[responseEdits.length - 1]?.text).toBe("Checking something");
    });

    it("no-ops when there is no accumulated text", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, STATUS_OFF);
      buffer.onToolStart("bash", {});
      await tick();
      // No text was emitted, so nothing to flush.
      expect(m.send.length).toBe(0);
      expect(m.edit.length).toBe(0);
    });
  });

  describe("response message segments at tool boundaries", () => {
    const STATUS_OFF = { visibility: "none" as const, responseThrottleMs: 200 };

    it("text → tool → text produces two distinct response bubbles", async () => {
      // Spec: "Response message segments at tool boundaries" — the seal
      // must clear responseMessageId so the second text segment becomes a
      // fresh sendMessage rather than an edit of the first bubble.
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      buffer.onTextDelta("Got it. Running bash now.");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text).toBe("Got it. Running bash now.");
      const firstMsgId = buffer._state().responseMessageId;
      expect(firstMsgId).toBeDefined();

      // Tool boundary seals the segment. Internally: force-flush (no-op
      // edit, since the send already covered the text) then reset state.
      t = 1100;
      buffer.onToolStart("bash", {});
      await tick();
      expect(buffer._state().responseMessageId).toBeUndefined();
      expect(buffer._state().accumulatedText).toBe("");

      buffer.onToolEnd("bash", false);

      // Second segment must be a brand-new sendMessage, not an edit.
      t = 5000;
      buffer.onTextDelta("Done. Output was 42.");
      await tick();
      expect(m.send.length).toBe(2);
      expect(m.send[1]?.text).toBe("Done. Output was 42.");
      expect(buffer._state().responseMessageId).not.toBe(firstMsgId);

      // No edit ever should have appended segment-2 text onto bubble-1.
      const cross = m.edit.filter((e) => e.text.includes("Done. Output was 42."));
      expect(cross.length).toBe(0);
    });

    it("naked tool call (no preamble text) emits no stub bubble", async () => {
      // Spec: "If a tool starts when no text has accumulated since the
      // last seal (or since turn start), the buffer SHALL NOT send
      // anything and SHALL NOT mutate state."
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, STATUS_OFF);

      buffer.onToolStart("delegate", {});
      await tick();
      expect(m.send.length).toBe(0);
      expect(buffer._state().responseMessageId).toBeUndefined();

      buffer.onToolEnd("delegate", false);
      buffer.onTextDelta("Subagents finished.");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]?.text).toBe("Subagents finished.");
    });

    it("text → tool → text → tool → text produces three response messages", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      buffer.onTextDelta("A.");
      await tick();
      t = 2000;
      buffer.onToolStart("bash", {});
      await tick();
      buffer.onToolEnd("bash", false);

      t = 3000;
      buffer.onTextDelta("B.");
      await tick();
      t = 4000;
      buffer.onToolStart("read", {});
      await tick();
      buffer.onToolEnd("read", false);

      t = 5000;
      buffer.onTextDelta("C.");
      await tick();

      // Three distinct sends, one per segment, in order.
      expect(m.send.map((s) => s.text)).toEqual(["A.", "B.", "C."]);
      // No edit should have ever cross-contaminated segments.
      for (const e of m.edit) {
        const inOne = e.text.includes("A.");
        const inTwo = e.text.includes("B.");
        const inThree = e.text.includes("C.");
        expect([inOne, inTwo, inThree].filter(Boolean).length).toBeLessThanOrEqual(1);
      }
    });

    it("final segment is force-flushed in full on agent_end", async () => {
      let t = 1000;
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        ...STATUS_OFF,
      });

      buffer.onTextDelta("First segment.");
      await tick();
      t = 1100;
      buffer.onToolStart("bash", {});
      await tick();
      buffer.onToolEnd("bash", false);

      // Stream the final segment in pieces; the last delta arrives within
      // the throttle window so the natural flush would be skipped.
      t = 5000;
      buffer.onTextDelta("Final ");
      await tick();
      t = 5050; // <200ms — natural flushResponse would be throttled out
      buffer.onTextDelta("answer.");
      buffer.onAgentEnd();
      await tick();

      // Two sends total: one per segment.
      expect(m.send.length).toBe(2);
      expect(m.send[0]?.text).toBe("First segment.");

      // The latest write to Telegram (whether the initial send or a
      // subsequent edit on agent_end) must be the complete final text.
      const lastWrite =
        m.edit.length > 0 ? m.edit[m.edit.length - 1]?.text : m.send[1]?.text;
      expect(lastWrite).toBe("Final answer.");

      // No edit ever touched bubble 1's id with the final-segment text.
      const bubble1Id = m.send[0] ? 101 : -1; // makeBot starts at 100, ++ before return → first id = 101
      const bubble1Edits = m.edit.filter((e) => e.messageId === bubble1Id);
      expect(bubble1Edits.every((e) => !e.text.includes("Final"))).toBe(true);
    });

    it("seal with rollover starts fresh segment (no cross-contamination)", async () => {
      // Bug: when accumulatedText > 4096 triggers rollover DURING the seal flush,
      // the old single-snapshot guard would see changed accumulatedText and
      // skip cleanup, leaving the tail message active. The next segment's
      // text would then edit that tail instead of creating a fresh message.
      let t = 1000;
      const m = makeBot();
      // Disable auto-flush so rollover happens during seal, not before
      const buffer = new MessageBuffer(m.bot, 1, undefined, {
        now: () => t,
        statusThrottleMs: Number.MAX_SAFE_INTEGER,
        responseThrottleMs: Number.MAX_SAFE_INTEGER,
        visibility: "none" as const,
      });

      // Accumulate >4096 chars WITHOUT flushing (auto-flush is disabled)
      buffer.onTextDelta("a".repeat(MAX_MESSAGE_LEN + 100));
      // No await tick() - don't let natural flush happen
      expect(buffer._state().accumulatedText.length).toBe(MAX_MESSAGE_LEN + 100);
      expect(buffer._state().responseMessageId).toBeUndefined();

      // Tool boundary: seal triggers rollover DURING the flushResponse(true).
      // After rollover, the guard should recognize that msgId changed and
      // DO the cleanup — the tail message was already sent as message 102.
      t = 2000;
      buffer.onToolStart("bash", {});
      await tick();

      // Debug: check actual state after seal
      const stateAfterSeal = buffer._state();
      expect(stateAfterSeal.accumulatedText).toBe(""); // should be cleared
      expect(stateAfterSeal.responseMessageId).toBeUndefined(); // should be cleared

      buffer.onToolEnd("bash", false);

      // Second segment: should create a FRESH message (103), not edit message 102
      t = 3000;
      buffer.onTextDelta("Second segment after tool.");
      // Need explicit force-flush since auto-flush is disabled
      await buffer.flushResponse(true);

      // Should send a new message, not edit the tail
      expect(m.send.length).toBe(3); // 101 (head), 102 (tail), 103 (new segment)
      expect(m.send[2]?.text).toBe("Second segment after tool.");

      // Message 102 should never have been edited (only sent during rollover)
      const msg102Edits = m.edit.filter((e) => e.messageId === 102);
      expect(msg102Edits.length).toBe(0);
    });
  });

  describe("chat action refresh", () => {
    interface FakeScheduler {
      setIntervalFn: (fn: () => void, ms: number) => unknown;
      clearIntervalFn: (handle: unknown) => void;
      scheduled: { fn: () => void; ms: number; handle: number }[];
      cleared: number[];
      fire(i: number): void;
    }

    function fakeScheduler(): FakeScheduler {
      const scheduled: { fn: () => void; ms: number; handle: number }[] = [];
      const cleared: number[] = [];
      let nextHandle = 1;
      return {
        scheduled,
        cleared,
        setIntervalFn: (fn, ms) => {
          const handle = nextHandle++;
          scheduled.push({ fn, ms, handle });
          return handle;
        },
        clearIntervalFn: (handle) => {
          cleared.push(handle as number);
        },
        fire(i: number) {
          scheduled[i]!.fn();
        },
      };
    }

    function makeBufferWithScheduler(
      m: ReturnType<typeof makeBot>,
      sched: FakeScheduler,
      extra: Partial<{ chatActionMs: number; visibility: string }> = {},
    ) {
      return new MessageBuffer(m.bot, 1, undefined, {
        statusThrottleMs: Number.MAX_SAFE_INTEGER,
        responseThrottleMs: Number.MAX_SAFE_INTEGER,
        setIntervalFn: sched.setIntervalFn,
        clearIntervalFn: sched.clearIntervalFn,
        ...extra,
      });
    }

    it("first onTextDelta sends an immediate 'typing' chat action", async () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onTextDelta("hi");
      await tick();
      expect(m.chatActions.length).toBe(1);
      expect(m.chatActions[0]).toEqual({ chatId: 1, action: "typing" });
      expect(buffer._state().chatActionHandle).toBeDefined();
    });

    it("schedules the refresh interval at chatActionMs (default 4000)", () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onTextDelta("hi");
      expect(sched.scheduled.length).toBe(1);
      expect(sched.scheduled[0]?.ms).toBe(4000);
      expect(buffer._state().chatActionHandle).toBe(
        sched.scheduled[0]?.handle,
      );
    });

    it("respects custom chatActionMs option", () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched, { chatActionMs: 1500 });
      buffer.onTextDelta("x");
      expect(sched.scheduled[0]?.ms).toBe(1500);
    });

    it("subsequent onTextDelta is idempotent (no second interval)", async () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onTextDelta("a");
      buffer.onTextDelta("b");
      buffer.onTextDelta("c");
      await tick();
      expect(sched.scheduled.length).toBe(1);
      expect(m.chatActions.length).toBe(1);
    });

    it("firing the interval triggers another sendChatAction", async () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onTextDelta("hi");
      await tick();
      expect(m.chatActions.length).toBe(1);

      sched.fire(0);
      await tick();
      expect(m.chatActions.length).toBe(2);
      expect(m.chatActions[1]?.action).toBe("typing");
      expect(buffer._state().chatActionHandle).toBeDefined();
    });

    it("onAgentEnd clears the interval", async () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onTextDelta("hi");
      await tick();
      const handle = buffer._state().chatActionHandle;
      expect(handle).toBeDefined();

      buffer.onAgentEnd();
      expect(sched.cleared).toContain(handle as number);
      expect(buffer._state().chatActionHandle).toBeUndefined();
    });

    it("onAgentEnd is idempotent when no interval is running", () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onAgentEnd();
      expect(sched.cleared.length).toBe(0);
      expect(buffer._state().chatActionHandle).toBeUndefined();
    });

    it("after onAgentEnd, a stray onTextDelta does not re-arm the chat-action timer", async () => {
      const m = makeBot();
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      buffer.onTextDelta("first");
      buffer.onAgentEnd();
      buffer.onTextDelta("second");
      await tick();
      // Only the first delta arms the chat-action timer; the stray delta
      // after onAgentEnd is ignored because statusFrozen is true.
      expect(sched.scheduled.length).toBe(1);
      expect(m.chatActions.length).toBe(1);
    });

    it("does not throw if sendChatAction rejects", async () => {
      const m = makeBot();
      m.failNext.chatAction = new Error("network");
      const sched = fakeScheduler();
      const buffer = makeBufferWithScheduler(m, sched);
      expect(() => buffer.onTextDelta("hi")).not.toThrow();
      await tick();
      expect(buffer._state().chatActionHandle).toBeDefined();
    });
  });

  describe("MarkdownV2 parse mode on response sends", () => {
    it("sends response with parse_mode MarkdownV2", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        responseThrottleMs: 0,
        visibility: "none",
      });
      buffer.onTextDelta("hello");
      await tick();
      expect(m.send.length).toBe(1);
      expect(m.send[0]!.opts).toEqual({ parse_mode: "MarkdownV2" });
    });

    it("edits response with parse_mode MarkdownV2", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        responseThrottleMs: 0,
        visibility: "none",
      });
      buffer.onTextDelta("hello");
      await tick();
      buffer.onTextDelta(" world");
      await tick();
      expect(m.edit.length).toBeGreaterThanOrEqual(1);
      expect(m.edit[0]!.opts).toEqual({ parse_mode: "MarkdownV2" });
    });

    it("status-line sends remain plain text (no parse_mode)", async () => {
      const m = makeBot();
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        statusThrottleMs: 0,
        responseThrottleMs: 0,
        visibility: "standard",
      });
      buffer.onStatusUpdate("thinking");
      await tick();
      // The status sendMessage should NOT have parse_mode.
      expect(m.send.length).toBeGreaterThanOrEqual(1);
      const statusSend = m.send[0]!;
      expect(statusSend.opts?.parse_mode).toBeUndefined();
    });
  });

  describe("400 parse-error plain-text fallback", () => {
    it("falls back to plain text on a 400 parse error and sets sticky flag", async () => {
      const m = makeBot();
      m.failNext.send = { error_code: 400, description: "Bad Request: can't parse entities" };
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        responseThrottleMs: 0,
        visibility: "none",
      });
      buffer.onTextDelta("*bold text*");
      await tick();
      await tick();
      await tick();
      // The retry send should have no parse_mode (plain text).
      const retrySend = m.send.at(-1)!;
      expect(retrySend.opts?.parse_mode).toBeUndefined();
      expect(retrySend.text).toBe("bold text");
    });

    it("subsequent edits skip MarkdownV2 after sticky flag is set", async () => {
      const m = makeBot();
      m.failNext.send = { error_code: 400, description: "can't parse markdown" };
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        responseThrottleMs: 0,
        visibility: "none",
      });
      buffer.onTextDelta("*bold*");
      await tick();
      await tick();
      await tick();
      // First send failed with parse error (not pushed); retry was plain text.
      expect(m.send.length).toBe(1);
      expect(m.send[0]!.opts?.parse_mode).toBeUndefined();
      expect(m.send[0]!.text).toBe("bold");

      // Next delta triggers an edit — should be plain text (no parse_mode)
      // AND the text should be stripped (not raw markdown).
      buffer.onTextDelta(" more");
      await tick();
      await tick();
      expect(m.edit.length).toBeGreaterThanOrEqual(1);
      expect(m.edit[0]!.opts?.parse_mode).toBeUndefined();
      expect(m.edit[0]!.text).toBe("bold more");
    });

    it("resets sticky flag on tool boundary seal", async () => {
      const m = makeBot();
      m.failNext.send = { error_code: 400, description: "can't parse markdown" };
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        responseThrottleMs: 0,
        statusThrottleMs: 0,
        visibility: "none",
      });
      buffer.onTextDelta("*bad*");
      await tick();
      await tick();
      await tick();
      // Plain-text retry happened (first send failed, retry succeeded).
      expect(m.send.length).toBe(1);
      expect(m.send[0]!.opts?.parse_mode).toBeUndefined();

      // Tool start seals the segment and resets the flag.
      buffer.onToolStart("bash", {});
      await tick();
      await tick();
      await tick();

      // Next text delta should send with MarkdownV2 again.
      buffer.onTextDelta("good");
      await tick();
      await tick();
      const lastSend = m.send.at(-1)!;
      expect(lastSend.opts).toEqual({ parse_mode: "MarkdownV2" });
    });

    it("rollover head is stripped when sticky flag is set", async () => {
      const m = makeBot();
      m.failNext.send = { error_code: 400, description: "can't parse markdown" };
      const buffer = new MessageBuffer(m.bot, 123, undefined, {
        responseThrottleMs: 0,
        visibility: "none",
      });
      // Send markdown that triggers the parse-error fallback.
      buffer.onTextDelta("*bold*");
      await tick();
      await tick();
      await tick();
      expect(m.send[0]!.text).toBe("bold");
      expect(m.send[0]!.opts?.parse_mode).toBeUndefined();

      // Now accumulate enough text to trigger a rollover. The head (which
      // finalizes the current plain-text message) must be stripped.
      const filler = "x".repeat(MAX_MESSAGE_LEN + 10);
      buffer.onTextDelta(filler);
      await tick();
      await tick();
      await tick();

      // The rollover edit (head) should be plain text with stripped markdown.
      // The head contains "*bold*" + filler prefix → stripped to "bold" + filler.
      const rolloverEdit = m.edit.at(-1) ?? m.send.at(-1)!;
      expect(rolloverEdit.opts?.parse_mode).toBeUndefined();
      expect(rolloverEdit.text.startsWith("bold")).toBe(true);
      expect(rolloverEdit.text.includes("*")).toBe(false);
    });
  });

  describe("adjustForCodeSpan", () => {
    it("returns splitAt unchanged when backtick count is even", () => {
      const text = "hello `code` world more text here";
      expect(adjustForCodeSpan(text, 20)).toBe(20);
    });

    it("returns splitAt unchanged when there are no backticks", () => {
      const text = "no backticks here at all";
      expect(adjustForCodeSpan(text, 10)).toBe(10);
    });

    it("moves split backward when backtick count is odd", () => {
      const text = "hello `code without close here and more";
      // Backtick at index 6. splitAt=20 → odd count → move to 6.
      expect(adjustForCodeSpan(text, 20)).toBe(6);
    });

    it("does not count escaped backticks", () => {
      const text = "escaped \\` and `real";
      // The \` at index 9 is escaped (preceded by \). The unescaped backtick
      // is at index 15. splitAt=20 → odd count → move to 15.
      expect(adjustForCodeSpan(text, 20)).toBe(15);
    });

    it("handles multiple code spans (even count)", () => {
      const text = "a `b` c `d` e f g h i j k";
      expect(adjustForCodeSpan(text, 15)).toBe(15);
    });
  });
});
