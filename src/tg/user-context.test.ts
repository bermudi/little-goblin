import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { prepareUserContent, stripBotMention } from "./user-context.ts";

type MessageEntity = NonNullable<Context["msg"]>["entities"] extends (infer E)[] | undefined ? E : never;

function makeCtx(opts: {
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  captionEntities?: MessageEntity[];
}): Context {
  return {
    me: { id: 99, is_bot: true, first_name: "Goblin", username: "goblinbot" },
    from: opts.from,
    msg: {
      text: opts.text,
      caption: opts.caption,
      entities: opts.entities,
      caption_entities: opts.captionEntities,
    },
  } as unknown as Context;
}

describe("prepareUserContent", () => {
  it("prefixes text with first name and username", () => {
    const ctx = makeCtx({ from: { id: 1, first_name: "Daniel", username: "bermudi" }, text: "hello" });
    expect(prepareUserContent(ctx, "hello")).toBe("[From: Daniel (@bermudi)]\nhello");
  });

  it("prefixes text with first name only when username is absent", () => {
    const ctx = makeCtx({ from: { id: 1, first_name: "Daniel" }, text: "hello" });
    expect(prepareUserContent(ctx, "hello")).toBe("[From: Daniel]\nhello");
  });

  it("uses unknown when from is absent", () => {
    const ctx = makeCtx({ text: "hello" });
    expect(prepareUserContent(ctx, "hello")).toBe("[From: unknown]\nhello");
  });

  it("strips matching mention entities", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel", username: "bermudi" },
      text: "@goblinbot hello",
      entities: [{ type: "mention", offset: 0, length: 10 } as MessageEntity],
    });
    expect(prepareUserContent(ctx, "@goblinbot hello")).toBe("[From: Daniel (@bermudi)]\nhello");
  });

  it("strips matching text_mention entities", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "Goblin hello",
      entities: [{ type: "text_mention", offset: 0, length: 6, user: { id: 99, is_bot: true, first_name: "Goblin" } } as MessageEntity],
    });
    expect(stripBotMention(ctx, "Goblin hello")).toBe("hello");
  });

  it("preserves non-bot mentions", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "@someone hello",
      entities: [{ type: "mention", offset: 0, length: 8 } as MessageEntity],
    });
    expect(stripBotMention(ctx, "@someone hello")).toBe("@someone hello");
  });

  it("strips case-insensitive mention entities", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "@GOBLINBOT hello",
      entities: [{ type: "mention", offset: 0, length: 10 } as MessageEntity],
    });
    expect(stripBotMention(ctx, "@GOBLINBOT hello")).toBe("hello");
  });

  it("strips a plain-text @handle with no resolved entity", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "@goblinbot hello",
      entities: [],
    });
    expect(stripBotMention(ctx, "@goblinbot hello")).toBe("hello");
  });

  it("strips a plain-text @handle embedded in larger text", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "hey @goblinbot what's this",
      entities: [],
    });
    expect(stripBotMention(ctx, "hey @goblinbot what's this")).toBe("hey what's this");
  });

  it("does not strip a longer handle sharing the bot's prefix", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "@goblinbot5000 hello",
      entities: [],
    });
    expect(stripBotMention(ctx, "@goblinbot5000 hello")).toBe("@goblinbot5000 hello");
  });

  it("strips a plain-text @handle from a caption with no entities", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      caption: "@goblinbot see this",
      captionEntities: [],
    });
    expect(stripBotMention(ctx, "@goblinbot see this")).toBe("see this");
  });

  it("strips matching caption mention entities", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      caption: "@goblinbot see this",
      captionEntities: [{ type: "mention", offset: 0, length: 10 } as MessageEntity],
    });
    expect(stripBotMention(ctx, "@goblinbot see this")).toBe("see this");
  });

  it("strips text blocks and preserves image blocks", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel", username: "bermudi" },
      text: "@goblinbot look",
      entities: [{ type: "mention", offset: 0, length: 10 } as MessageEntity],
    });
    const image: ImageContent = { type: "image", data: "abc", mimeType: "image/jpeg" };
    const content: (TextContent | ImageContent)[] = [{ type: "text", text: "@goblinbot look" }, image];

    expect(prepareUserContent(ctx, content)).toEqual([
      { type: "text", text: "[From: Daniel (@bermudi)]" },
      { type: "text", text: "look" },
      image,
    ]);
  });

  it("keeps only the prefix line when stripping leaves empty text", () => {
    const ctx = makeCtx({
      from: { id: 1, first_name: "Daniel" },
      text: "@goblinbot",
      entities: [{ type: "mention", offset: 0, length: 10 } as MessageEntity],
    });
    expect(prepareUserContent(ctx, "@goblinbot")).toBe("[From: Daniel]\n");
  });
});
