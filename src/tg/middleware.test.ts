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
    voiceName: "en-US-AriaNeural",
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
  guestMessage?: { from?: { id: number; first_name?: string; username?: string }; text?: string; chat?: { id: number } };
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
      update: opts.guestMessage ? { guest_message: opts.guestMessage } : {},
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

  describe("guest_message", () => {
    it("passes a guest_message from an allowed summoner", async () => {
      const { ctx } = makeCtx({
        guestMessage: { from: { id: 1, first_name: "Daniel", username: "daniel" }, text: "@goblinbot hi", chat: { id: -42 } },
      });
      expect(await run(ctx)).toHaveBeenCalledTimes(1);
    });

    it("drops a guest_message from a non-allowed summoner without calling next", async () => {
      const { ctx } = makeCtx({
        guestMessage: { from: { id: 2, first_name: "Mallory", username: "mallory" }, text: "@goblinbot hi", chat: { id: -42 } },
      });
      expect(await run(ctx)).not.toHaveBeenCalled();
    });

    it("does not log guest_query_id when dropping a non-allowed summoner", async () => {
      // Enable debug logging so the drop line is emitted, then capture stdout.
      const originalWrite = process.stdout.write.bind(process.stdout);
      const lines: string[] = [];
      // The middleware logs at debug; force the threshold down by spying on
      // emit via stdout capture. We pass a guest_message carrying a real-looking
      // guest_query_id and assert the value never reaches the stream.
      const written = mock((chunk: string | Uint8Array) => {
        lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });
      process.stdout.write = written as unknown as typeof process.stdout.write;

      // Initialize debug level so the drop log is actually emitted.
      const { initLog } = await import("../log.ts");
      initLog("debug");

      try {
        const { ctx } = makeCtx({
          guestMessage: {
            // Include a guest_query_id on the update shape to prove it's never
            // surfaced. The middleware must only read .from.
            from: { id: 2, first_name: "Mallory", username: "mallory" },
            text: "@goblinbot hi",
            chat: { id: -42 },
            // @ts-expect-error — guest_query_id is intentionally not part of
            // the test stub type; we add it to verify it never leaks.
            guest_query_id: "AAAA_SECRET_ID",
          },
        });
        await run(ctx);

        const blob = lines.join("");
        expect(blob).not.toContain("guest_query_id");
        expect(blob).not.toContain("AAAA_SECRET_ID");
        expect(blob).toContain("dropping guest_message from non-allowed user");
        expect(blob).toContain("mallory");
      } finally {
        process.stdout.write = originalWrite;
        initLog("error"); // restore to a quiet level for the rest of the suite
      }
    });

    it("does not log guest_query_id when allowing an allowed summoner", async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      const lines: string[] = [];
      process.stdout.write = mock((chunk: string | Uint8Array) => {
        lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as unknown as typeof process.stdout.write;

      const { initLog } = await import("../log.ts");
      initLog("debug");

      try {
        const { ctx } = makeCtx({
          guestMessage: {
            from: { id: 1, first_name: "Daniel", username: "daniel" },
            text: "@goblinbot hi",
            chat: { id: -42 },
            // @ts-expect-error — see above
            guest_query_id: "BBBB_SECRET_ID",
          },
        });
        await run(ctx);

        const blob = lines.join("");
        expect(blob).not.toContain("guest_query_id");
        expect(blob).not.toContain("BBBB_SECRET_ID");
      } finally {
        process.stdout.write = originalWrite;
        initLog("error");
      }
    });

    it("passes a guest_message without ctx.chat/ctx.from populated (grammy leaves these unset)", async () => {
      // grammy does not derive ctx.chat/ctx.from for guest_message — confirm
      // the guest branch fires before the !ctx.chat/!ctx.from pass-through.
      const { ctx } = makeCtx({
        // chat/from intentionally omitted.
        guestMessage: { from: { id: 1, first_name: "Daniel" }, text: "hi", chat: { id: -42 } },
      });
      expect(await run(ctx)).toHaveBeenCalledTimes(1);
    });
  });
});
