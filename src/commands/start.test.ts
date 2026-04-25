import { describe, it, expect } from "bun:test";
import type { Context } from "grammy";
import { buildStartHandler } from "./start.ts";
import type { SessionManager } from "../sessions/mod.ts";
import type { SessionState } from "../sessions/types.ts";

type ReplyCall = { text: string; opts?: Record<string, unknown> };

function makeCtx(overrides: {
  chat: { id: number; type: string };
  msg?: { message_thread_id?: number; is_topic_message?: boolean };
  reply?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
}): Context {
  return {
    chat: overrides.chat,
    msg: overrides.msg,
    reply: overrides.reply ?? (async () => ({ message_id: 1 }) as unknown),
  } as unknown as Context;
}

function makeManager(sessionId: string): SessionManager {
  return {
    createForChat: () =>
      ({ id: sessionId, createdAt: new Date().toISOString(), chatId: 123 }) as SessionState,
  } as unknown as SessionManager;
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

    const manager = makeManager("sess-abc-123");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("Session `sess-abc-123` ready. Just start typing!");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2" });
  });

  it("welcomes user in DM with General topic thread", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: 123, type: "private" },
      msg: { message_thread_id: 1, is_topic_message: false },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const manager = makeManager("sess-def-456");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.opts).toEqual({
      parse_mode: "MarkdownV2",
      message_thread_id: 1,
    });
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

    const manager = makeManager("unused");
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

    const manager = makeManager("unused");
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

    const manager = makeManager("unused");
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("Unable to determine chat context.");
  });
});
