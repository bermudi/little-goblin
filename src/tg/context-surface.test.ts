import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { surfaceFromCtx } from "./context-surface.ts";

interface MakeCtxOptions {
  chat?: { id: number; type: "private" | "group" | "supergroup" | "channel"; is_direct_messages?: true; is_forum?: boolean };
  msg?: {
    is_topic_message?: boolean;
    message_thread_id?: number;
    direct_messages_topic?: { topic_id: number };
  };
  guestMessage?: { chat?: { id: number } };
}

function makeCtx(opts: MakeCtxOptions): Context {
  return {
    chat: opts.chat,
    msg: opts.msg,
    guestMessage: opts.guestMessage,
  } as unknown as Context;
}

describe("surfaceFromCtx", () => {
  it("normalizes a topicless private chat to dm", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: 889192981, type: "private" }, msg: {} }))).toEqual({
      kind: "dm",
      chatId: 889192981,
    });
  });

  it("normalizes a private-chat topic", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: 889192981, type: "private" },
          msg: { is_topic_message: true, message_thread_id: 42 },
        }),
      ),
    ).toEqual({
      kind: "topic",
      container: "private",
      chatId: 889192981,
      topicId: 42,
    });
  });

  it("normalizes a forum-supergroup topic", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup" },
          msg: { is_topic_message: true, message_thread_id: 180 },
        }),
      ),
    ).toEqual({
      kind: "topic",
      container: "supergroup",
      chatId: -1003958530002,
      topicId: 180,
    });
  });

  it("normalizes a direct-messages topic", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup", is_direct_messages: true },
          msg: { direct_messages_topic: { topic_id: 91 } },
        }),
      ),
    ).toEqual({
      kind: "topic",
      container: "direct-messages",
      chatId: -1003958530002,
      topicId: 91,
    });
  });

  it("prioritizes direct_messages_topic over is_topic_message", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup", is_direct_messages: true },
          msg: {
            is_topic_message: true,
            message_thread_id: 5,
            direct_messages_topic: { topic_id: 91 },
          },
        }),
      ),
    ).toEqual({
      kind: "topic",
      container: "direct-messages",
      chatId: -1003958530002,
      topicId: 91,
    });
  });

  it("rejects direct_messages_topic without is_direct_messages chat", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup" },
          msg: { direct_messages_topic: { topic_id: 91 } },
        }),
      ),
    ).toBeNull();
  });

  it("normalizes a topicless supergroup", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: -1003958530002, type: "supergroup" }, msg: {} }))).toEqual({
      kind: "supergroup",
      chatId: -1003958530002,
    });
  });

  it("normalizes a forum General topic", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup", is_forum: true },
          msg: { is_topic_message: false, message_thread_id: 1 },
        }),
      ),
    ).toEqual({
      kind: "topic",
      container: "supergroup",
      chatId: -1003958530002,
      topicId: 1,
    });
  });

  it("rejects forum General-topic metadata with a non-General thread id", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup", is_forum: true },
          msg: { is_topic_message: false, message_thread_id: 42 },
        }),
      ),
    ).toBeNull();
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup", is_forum: true },
          msg: { message_thread_id: 42 },
        }),
      ),
    ).toBeNull();
  });

  it("does not treat a non-forum supergroup message_thread_id as a topic", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1003958530002, type: "supergroup" },
          msg: { is_topic_message: false, message_thread_id: 42 },
        }),
      ),
    ).toEqual({
      kind: "supergroup",
      chatId: -1003958530002,
    });
  });

  it("normalizes a guest summon", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          guestMessage: { chat: { id: -42 } },
        }),
      ),
    ).toEqual({
      kind: "guest",
      chatId: -42,
    });
  });

  it("rejects a group chat", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: -123, type: "group" }, msg: {} }))).toBeNull();
  });

  it("rejects an ordinary channel post", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: -1001, type: "channel" }, msg: {} }))).toBeNull();
  });

  it("rejects missing chat", () => {
    expect(surfaceFromCtx(makeCtx({ msg: {} }))).toBeNull();
  });

  it("normalizes a private chat even when the message object is absent", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: 1, type: "private" } }))).toEqual({
      kind: "dm",
      chatId: 1,
    });
  });

  it("rejects zero chat ids", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: 0, type: "private" }, msg: {} }))).toBeNull();
    expect(surfaceFromCtx(makeCtx({ guestMessage: { chat: { id: 0 } } }))).toBeNull();
  });

  it("rejects unsafe chat ids", () => {
    expect(surfaceFromCtx(makeCtx({ chat: { id: Number.MAX_SAFE_INTEGER + 1, type: "private" }, msg: {} }))).toBeNull();
  });

  it("rejects non-positive topic ids", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: 42, type: "private" },
          msg: { is_topic_message: true, message_thread_id: 0 },
        }),
      ),
    ).toBeNull();
  });

  it("rejects a supergroup topic in a direct-messages chat", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1001, type: "supergroup", is_direct_messages: true },
          msg: { is_topic_message: true, message_thread_id: 7 },
        }),
      ),
    ).toBeNull();
  });

  it("rejects a topicless direct-messages supergroup", () => {
    expect(
      surfaceFromCtx(
        makeCtx({
          chat: { id: -1001, type: "supergroup", is_direct_messages: true },
          msg: {},
        }),
      ),
    ).toBeNull();
  });
});
