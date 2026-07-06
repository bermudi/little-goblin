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

function makeManager(
  sessionId: string,
  existing?: SessionState | null,
): { manager: SessionManager; calls: ChatLocator[]; resolveCalls: ChatLocator[] } {
  const calls: ChatLocator[] = [];
  const resolveCalls: ChatLocator[] = [];
  const manager = {
    resolve: (loc: ChatLocator) => {
      resolveCalls.push(loc);
      return existing ?? null;
    },
    createForChat: (loc: ChatLocator) => {
      calls.push(loc);
      return { id: sessionId, createdAt: new Date().toISOString(), chatId: loc.chatId, topicId: loc.topicId } as SessionState;
    },
  } as unknown as SessionManager;
  return { manager, calls, resolveCalls };
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
    expect(replies[0]!.text).toBe("`[info]` Session `sess-abc-123` ready\\. Just start typing\\!");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(calls.length).toBe(1);
    expect(calls[0]!).toEqual({ chatId: 123, topicId: undefined });
  });

  it("welcomes back without creating when DM session already exists", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: 123, type: "private" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const existing: SessionState = {
      id: "existing-99",
      createdAt: new Date().toISOString(),
      chatId: 123,
      topicId: undefined,
    };
    const { manager, calls } = makeManager("unused", existing);
    const handler = buildStartHandler(manager);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` Welcome back\\. Session `existing-99` is active\\. Use /new for a fresh one\\.",
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(calls.length).toBe(0); // No new session created
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
    expect(replies[0]!.text).toBe("`[info]` This topic is already its own session\\. Just start typing\\!");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true, message_thread_id: 1 });
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
    expect(replies[0]!.text).toBe("`[info]` Use /start in a private chat or a forum topic\\.");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
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
    expect(replies[0]!.text).toBe("`[info]` This topic is already its own session\\. Just start typing\\!");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true, message_thread_id: 42 });
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
    expect(replies[0]!.text).toBe("`[error]` Unable to determine chat context\\.");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
  });
});
