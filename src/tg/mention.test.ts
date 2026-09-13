import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "grammy";
import {
  botHandlePattern,
  botMentionRanges,
  isBotMentioned,
  stripBotMention,
} from "./mention.ts";

type MessageEntity = NonNullable<Context["msg"]>["entities"] extends (infer E)[] | undefined ? E : never;

const BOT = { id: 99, username: "goblinbot" };

function makeCtx(opts: {
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  captionEntities?: MessageEntity[];
  username?: string;
}): Context {
  return {
    me: {
      id: 99,
      is_bot: true,
      first_name: "Goblin",
      username: "username" in opts ? opts.username : "goblinbot",
    },
    msg: {
      text: opts.text,
      caption: opts.caption,
      entities: opts.entities,
      caption_entities: opts.captionEntities,
    },
  } as unknown as Context;
}

describe("botMentionRanges", () => {
  it("collects ranges for mention entities matching the bot username", () => {
    const entities = [{ type: "mention", offset: 4, length: 10 } as MessageEntity];
    expect(botMentionRanges(BOT, "hey @goblinbot", entities)).toEqual([[4, 14]]);
  });

  it("matches the bot username case-insensitively", () => {
    const entities = [{ type: "mention", offset: 0, length: 10 } as MessageEntity];
    expect(botMentionRanges(BOT, "@GOBLINBOT hi", entities)).toEqual([[0, 10]]);
  });

  it("collects ranges for text_mention entities matching the bot id", () => {
    const entities = [
      { type: "text_mention", offset: 0, length: 6, user: { id: 99, is_bot: true, first_name: "Goblin" } } as MessageEntity,
    ];
    expect(botMentionRanges(BOT, "Goblin hi", entities)).toEqual([[0, 6]]);
  });

  it("ignores mentions of other usernames and text_mentions of other users", () => {
    const entities = [
      { type: "mention", offset: 0, length: 8 } as MessageEntity,
      { type: "text_mention", offset: 9, length: 7, user: { id: 42, is_bot: false, first_name: "Someone" } } as MessageEntity,
    ];
    expect(botMentionRanges(BOT, "@someone Someone", entities)).toEqual([]);
  });

  it("collects multiple ranges across entity kinds", () => {
    const entities = [
      { type: "mention", offset: 0, length: 10 } as MessageEntity,
      { type: "text_mention", offset: 20, length: 6, user: { id: 99, is_bot: true, first_name: "G" } } as MessageEntity,
    ];
    expect(botMentionRanges(BOT, "@goblinbot          Goblin", entities)).toEqual([
      [0, 10],
      [20, 26],
    ]);
  });
});

describe("botHandlePattern", () => {
  it("matches a bare @handle case-insensitively", () => {
    expect(botHandlePattern("goblinbot").test("hey @GOBLINBOT")).toBe(true);
  });

  it("requires a trailing word boundary", () => {
    expect(botHandlePattern("goblinbot").test("hi @goblinbot5000")).toBe(false);
  });

  it("escapes regex metacharacters in the username", () => {
    expect(botHandlePattern("go.blin").test("@goXblin")).toBe(false);
    expect(botHandlePattern("go.blin").test("@go.blin")).toBe(true);
  });
});

describe("isBotMentioned", () => {
  it("detects a mention entity for the bot", () => {
    const ctx = makeCtx({
      text: "hey @goblinbot",
      entities: [{ type: "mention", offset: 4, length: 10 } as MessageEntity],
    });
    expect(isBotMentioned(ctx)).toBe(true);
  });

  it("detects a text_mention entity for the bot", () => {
    const ctx = makeCtx({
      text: "hey goblin",
      entities: [
        { type: "text_mention", offset: 4, length: 6, user: { id: 99, is_bot: true, first_name: "Goblin" } } as MessageEntity,
      ],
    });
    expect(isBotMentioned(ctx)).toBe(true);
  });

  it("detects a bare @handle the client never resolved into an entity", () => {
    const ctx = makeCtx({ text: "@goblinbot hola?", entities: [] });
    expect(isBotMentioned(ctx)).toBe(true);
  });

  it("ignores a bare handle followed by a word character", () => {
    const ctx = makeCtx({ text: "@goblinbot5000 hi", entities: [] });
    expect(isBotMentioned(ctx)).toBe(false);
  });

  it("checks caption_entities for media messages", () => {
    const ctx = makeCtx({
      caption: "@goblinbot look",
      captionEntities: [{ type: "mention", offset: 0, length: 10 } as MessageEntity],
    });
    expect(isBotMentioned(ctx)).toBe(true);
  });

  it("checks the bare handle in a caption", () => {
    const ctx = makeCtx({ caption: "@goblinbot look" });
    expect(isBotMentioned(ctx)).toBe(true);
  });

  it("returns false when the bot has no username", () => {
    const ctx = makeCtx({ text: "@goblinbot hi", entities: [], username: undefined });
    expect(isBotMentioned(ctx)).toBe(false);
  });
});

describe("stripBotMention", () => {
  it("removes entity ranges back-to-front, preserving offsets", () => {
    const ctx = makeCtx({
      text: "@goblinbot hi @goblinbot",
      entities: [
        { type: "mention", offset: 0, length: 10 } as MessageEntity,
        { type: "mention", offset: 14, length: 10 } as MessageEntity,
      ],
    });
    expect(stripBotMention(ctx, "@goblinbot hi @goblinbot")).toBe("hi");
  });

  it("strips bare @handle occurrences when no entity matched", () => {
    const ctx = makeCtx({ text: "hey @goblinbot what's this", entities: [] });
    expect(stripBotMention(ctx, "hey @goblinbot what's this")).toBe("hey what's this");
  });

  it("returns text unchanged when the bot has no username", () => {
    const ctx = makeCtx({ text: "@goblinbot hi", entities: [], username: undefined });
    expect(stripBotMention(ctx, "@goblinbot hi")).toBe("@goblinbot hi");
  });
});

describe("mention ownership", () => {
  for (const file of ["middleware.ts", "user-context.ts"]) {
    it(`${file} delegates to ./mention.ts and holds no independent mention matching`, () => {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(src).toContain('"./mention.ts"');
      expect(src).not.toMatch(/type === "mention"/);
      expect(src).not.toMatch(/type === "text_mention"/);
      expect(src).not.toContain("includes(`@");
      expect(src).not.toMatch(/new RegExp\(`@/);
    });
  }
});
