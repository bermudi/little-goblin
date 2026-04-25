import { describe, it, expect } from "bun:test";
import type { Context } from "grammy";
import { buildStartHandler } from "./start.ts";
import type { SessionManager } from "../sessions/mod.ts";
import type { SessionState, ChatLocator } from "../sessions/types.ts";

type ReplyCall = { text: string; opts?: Record<string, unknown> };

function makeCtx(overrides: {
  chat: { id: number; type: string };
  msg?: { message_thread_id?: number; is_topic_message?: boolean };
  reply?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  from?: { id: number };
}): Context {
  return {
    chat: overrides.chat,
    msg: overrides.msg,
    reply: overrides.reply ?? (async () => ({ message_id: 1 }) as unknown),
    from: overrides.from ?? { id: 1 },
  } as unknown as Context;
}

function makeManager(sessionId: string): { manager: SessionManager; calls: ChatLocator[] } {
  const calls: ChatLocator[] = [];
  const manager = {
    createForChat: (loc: ChatLocator) => {
      calls.push(loc);
      return { id: sessionId, createdAt: new Date().toISOString(), chatId: loc.chatId, topicId: loc.topicId } as SessionState;
    },
  } as unknown as SessionManager;
  return { manager, calls };
}

describe("buildStartHandler", () => {
  it("creates session and welcomes user in DM", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: 123, type: "private" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { manager, calls } = makeManager("sess-abc-123");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("Session `sess-abc-123` ready. Just start typing!");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2" });
    expect(calls.length).toBe(1);
    expect(calls[0]!).toEqual({ chatId: 123, topicId: undefined });
  });

  it("informs that forum General topic is already a session", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: -789, type: "supergroup" },
      msg: { message_thread_id: 1, is_topic_message: false },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { manager, calls } = makeManager("unused");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("This topic is already its own session. Just start typing!");
    expect(replies[0]!.opts).toEqual({ message_thread_id: 1 });
    expect(calls.length).toBe(0); // No session created for forum topics
  });

  it("rejects in plain group chat", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: -456, type: "group" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { manager } = makeManager("unused");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("Use /start in a private chat or a forum topic.");
  });

  it("informs that topic is already a session", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: -789, type: "supergroup" },
      msg: { message_thread_id: 42, is_topic_message: true },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { manager } = makeManager("unused");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("This topic is already its own session. Just start typing!");
    expect(replies[0]!.opts).toEqual({ message_thread_id: 42 });
  });

  it("handles missing locator", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: undefined as unknown as number, type: "private" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { manager } = makeManager("unused");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("Unable to determine chat context.");
  });
});
