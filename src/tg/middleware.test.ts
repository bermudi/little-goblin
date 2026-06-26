import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type { Context, NextFunction } from "grammy";
import type { Config } from "../config.ts";
import { buildAllowlistMiddleware } from "./middleware.ts";

type MessageEntity = NonNullable<Context["msg"]>["entities"] extends (infer E)[] | undefined ? E : never;

function makeConfig(): Config {
  return {
    botToken: "token",
    allowedTgUserIds: new Set([1]),
    modelName: "openai/gpt-4o",
    goblinHome: "/tmp/goblin-test",
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    favorites: [],
  };
}

function makeCtx(opts: {
  chat?: { id: number; type: "private" | "group" | "supergroup" };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  captionEntities?: MessageEntity[];
  memberCount?: number;
  memberCountError?: unknown;
  replyToMessage?: { from?: { id: number }; forum_topic_created?: unknown };
}): { ctx: Context; getChatMemberCount: ReturnType<typeof mock> } {
  const getChatMemberCount = mock(async () => {
    if (opts.memberCountError !== undefined) throw opts.memberCountError;
    return opts.memberCount ?? 5;
  });
  return {
    ctx: {
      chat: opts.chat,
      from: opts.from,
      me: { id: 99, is_bot: true, first_name: "Goblin", username: "goblinbot" },
      msg: opts.text !== undefined || opts.caption !== undefined || opts.replyToMessage !== undefined
        ? {
            text: opts.text,
            entities: opts.entities,
            caption: opts.caption,
            caption_entities: opts.captionEntities,
            reply_to_message: opts.replyToMessage,
          }
        : undefined,
      api: { getChatMemberCount },
    } as unknown as Context,
    getChatMemberCount,
  };
}

async function run(ctx: Context): Promise<ReturnType<typeof mock>> {
  const next = mock(async () => {});
  await buildAllowlistMiddleware(makeConfig())(ctx, next as unknown as NextFunction);
  return next;
}

afterEach(() => {
  setSystemTime();
});

describe("buildAllowlistMiddleware", () => {
  it("passes DMs from allowed users", async () => {
    const { ctx } = makeCtx({ chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Daniel" }, text: "hi" });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("drops DMs from non-allowed users", async () => {
    const { ctx } = makeCtx({ chat: { id: 1, type: "private" }, from: { id: 2, first_name: "Mallory" }, text: "hi" });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("passes group mention entities from any user", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 2, first_name: "Mallory" },
      text: "hey @goblinbot",
      entities: [{ type: "mention", offset: 4, length: 10 } as MessageEntity],
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("passes group text_mention entities for the bot from any user", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 2, first_name: "Mallory" },
      text: "hey goblin",
      entities: [{ type: "text_mention", offset: 4, length: 6, user: { id: 99, is_bot: true, first_name: "Goblin" } } as MessageEntity],
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("passes case-insensitive @mention entities for the bot", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 2, first_name: "Mallory" },
      text: "hey @GOBLINBOT",
      entities: [{ type: "mention", offset: 4, length: 10 } as MessageEntity],
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("passes a plain-text @handle that the client never resolved into an entity", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 2, first_name: "Mallory" },
      text: "@goblinbot hola?",
      entities: [],
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("passes a plain-text @handle embedded in larger text with no entity", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "hola? @goblinbot",
      entities: [],
      memberCount: 3,
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("does not false-positive on a longer handle sharing the bot's prefix", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "@goblinbot5000 hi",
      entities: [],
      memberCount: 3,
    });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("does not false-positive on a different bot's handle", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "@otherbot hi",
      entities: [],
      memberCount: 3,
    });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("passes a direct reply to a bot message in a large group from any user", async () => {
    const { ctx, getChatMemberCount } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 2, first_name: "Mallory" },
      text: "what did you mean?",
      entities: [],
      memberCount: 5,
      replyToMessage: { from: { id: 99 } },
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
    expect(getChatMemberCount).not.toHaveBeenCalled();
  });

  it("passes a direct reply to a bot message from an allowed user without consulting member count", async () => {
    const { ctx, getChatMemberCount } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "ok",
      replyToMessage: { from: { id: 99 } },
      memberCount: 10,
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
    expect(getChatMemberCount).not.toHaveBeenCalled();
  });

  it("does not wake on a reply to a non-bot message in a large group", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "ok",
      memberCount: 5,
      replyToMessage: { from: { id: 2 } },
    });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("does not wake on a forum topic anchor (service message) as the reply target", async () => {
    const { ctx } = makeCtx({
      chat: { id: -1, type: "supergroup" },
      from: { id: 1, first_name: "Daniel" },
      text: "just chatting",
      memberCount: 5,
      replyToMessage: { from: { id: 99 }, forum_topic_created: {} },
    });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("passes allowed-user slash commands in large groups without consulting member count", async () => {
    const { ctx, getChatMemberCount } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "/new",
      entities: [{ type: "bot_command", offset: 0, length: 4 } as MessageEntity],
      memberCount: 5,
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
    expect(getChatMemberCount).not.toHaveBeenCalled();
  });

  it("passes allowed-user slash commands in small groups without consulting member count", async () => {
    const { ctx, getChatMemberCount } = makeCtx({
      chat: { id: -1, type: "group" },
      from: { id: 1, first_name: "Daniel" },
      text: "/new",
      entities: [{ type: "bot_command", offset: 0, length: 4 } as MessageEntity],
      memberCount: 2,
    });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
    expect(getChatMemberCount).not.toHaveBeenCalled();
  });

  it("passes allowed-user text in small groups", async () => {
    const { ctx, getChatMemberCount } = makeCtx({ chat: { id: -1, type: "group" }, from: { id: 1, first_name: "Daniel" }, text: "hi", memberCount: 2 });
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
    expect(getChatMemberCount).toHaveBeenCalledTimes(1);
  });

  it("drops allowed-user text in large groups without mention", async () => {
    const { ctx } = makeCtx({ chat: { id: -1, type: "group" }, from: { id: 1, first_name: "Daniel" }, text: "hi", memberCount: 5 });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("drops non-allowed-user group text without mention", async () => {
    const { ctx } = makeCtx({ chat: { id: -1, type: "group" }, from: { id: 2, first_name: "Mallory" }, text: "hi" });
    expect(await run(ctx)).not.toHaveBeenCalled();
  });

  it("passes non-message updates", async () => {
    const { ctx } = makeCtx({});
    expect(await run(ctx)).toHaveBeenCalledTimes(1);
  });

  it("caches member counts for five minutes", async () => {
    setSystemTime(new Date("2026-06-10T00:00:00Z"));
    const middleware = buildAllowlistMiddleware(makeConfig());
    const { ctx, getChatMemberCount } = makeCtx({ chat: { id: -1, type: "group" }, from: { id: 1, first_name: "Daniel" }, text: "hi", memberCount: 2 });

    await middleware(ctx, mock(async () => {}) as unknown as NextFunction);
    await middleware(ctx, mock(async () => {}) as unknown as NextFunction);
    expect(getChatMemberCount).toHaveBeenCalledTimes(1);

    setSystemTime(new Date("2026-06-10T00:05:00Z"));
    await middleware(ctx, mock(async () => {}) as unknown as NextFunction);
    expect(getChatMemberCount).toHaveBeenCalledTimes(2);
  });

  it("treats member-count failures as large groups for allowed-user text", async () => {
    const { ctx, getChatMemberCount } = makeCtx({ chat: { id: -1, type: "group" }, from: { id: 1, first_name: "Daniel" }, text: "hi", memberCountError: new Error("nope") });
    expect(await run(ctx)).not.toHaveBeenCalled();
    expect(getChatMemberCount).toHaveBeenCalledTimes(1);
  });
});
