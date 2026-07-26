import { describe, it, expect } from "bun:test";
import type { Context } from "grammy";
import { buildStartHandler } from "./start.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { ConversationState } from "../sessions/types.ts";
import { dmSurface, topicSurface, type Surface } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";

type ReplyCall = { text: string; opts?: Record<string, unknown> };

function makeCtx(overrides: {
  chat: { id: number; type: string; is_forum?: boolean };
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

function makeLifecycle(
  existing?: ConversationState | null,
): { lifecycle: ConversationLifecycle; inspectCalls: Surface[] } {
  const inspectCalls: Surface[] = [];
  const lifecycle = {
    inspect: (surface: Surface) => {
      inspectCalls.push(surface);
      return existing ?? null;
    },
  } as unknown as ConversationLifecycle;
  return { lifecycle, inspectCalls };
}

function conversation(id: string): ConversationState {
  return {
    id,
    createdAt: new Date().toISOString(),
    executionEnvironment: personalEnvironment(),
  };
}

describe("buildStartHandler", () => {
  it("welcomes user and reports active conversation in DM", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: 123, type: "private" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { lifecycle, inspectCalls } = makeLifecycle(conversation("conv-abc-123"));
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` Welcome back\\. Conversation `conv-abc-123` is active\\. Use /new for a fresh one\\.",
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(inspectCalls.length).toBe(1);
    expect(inspectCalls[0]!).toEqual(dmSurface(123));
  });

  it("explains how to start a conversation when DM is unbound", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: 123, type: "private" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { lifecycle, inspectCalls } = makeLifecycle(null);
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` No active conversation\\. Send any message to start one, or use /new to create one explicitly\\.",
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(inspectCalls.length).toBe(1);
    expect(inspectCalls[0]!).toEqual(dmSurface(123));
  });

  it("explains how to start a conversation in the General topic", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: -789, type: "supergroup", is_forum: true },
      msg: { message_thread_id: 1, is_topic_message: false },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { lifecycle, inspectCalls } = makeLifecycle(null);
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` No active conversation\\. Send any message to start one, or use /new to create one explicitly\\.",
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(inspectCalls.length).toBe(1);
    expect(inspectCalls[0]!).toEqual(topicSurface("supergroup", -789, 1));
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

    const { lifecycle, inspectCalls } = makeLifecycle(null);
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("`[info]` Use /start in a private chat or a forum topic\\.");
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(inspectCalls.length).toBe(0);
  });

  it("explains how to start a conversation in an unbound topic", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: -789, type: "supergroup" },
      msg: { message_thread_id: 42, is_topic_message: true },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { lifecycle, inspectCalls } = makeLifecycle(null);
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` No active conversation\\. Send any message to start one, or use /new to create one explicitly\\.",
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true, message_thread_id: 42 });
    expect(inspectCalls.length).toBe(1);
    expect(inspectCalls[0]!).toEqual(topicSurface("supergroup", -789, 42));
  });

  it("welcomes back in a bound topic", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: -789, type: "supergroup" },
      msg: { message_thread_id: 42, is_topic_message: true },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { lifecycle, inspectCalls } = makeLifecycle(conversation("conv-abc-123"));
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` Welcome back\\. Conversation `conv-abc-123` is active\\. Use /new for a fresh one\\.",
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true, message_thread_id: 42 });
    expect(inspectCalls.length).toBe(1);
    expect(inspectCalls[0]!).toEqual(topicSurface("supergroup", -789, 42));
  });

  it("handles missing surface", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeCtx({
      chat: { id: undefined as unknown as number, type: "private" },
      reply: async (text, opts) => {
        replies.push({ text, opts });
        return { message_id: 1 };
      },
    });

    const { lifecycle, inspectCalls } = makeLifecycle(null);
    const handler = buildStartHandler(lifecycle);
    await handler(ctx);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe(
      "`[info]` Use /start in a private chat or a forum topic\\."
    );
    expect(replies[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
    expect(inspectCalls.length).toBe(0);
  });
});
