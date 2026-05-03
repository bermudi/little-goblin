import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import {
  createSendVoiceTool,
  createSendPhotoTool,
  createSendDocumentTool,
  createReactTool,
  createRenameTopicTool,
  createChatActionTool,
} from "./tools.ts";

interface SendCall {
  chatId: number | string;
  file: InputFile;
  other: { caption?: string } | undefined;
}

interface ReactionCall {
  chatId: number | string;
  messageId: number;
  reaction: { type: "emoji"; emoji: string }[];
}

interface ChatActionCall {
  chatId: number | string;
  action: string;
}

interface RenameTopicCall {
  chatId: number | string;
  topicId: number;
  title: string;
}

interface MockBot {
  bot: Bot;
  voice: SendCall[];
  photo: SendCall[];
  document: SendCall[];
  reactions: ReactionCall[];
  chatActions: ChatActionCall[];
  renames: RenameTopicCall[];
  failNext: {
    voice?: unknown;
    photo?: unknown;
    document?: unknown;
    reaction?: unknown;
    chatAction?: unknown;
    rename?: unknown;
  };
  nextMessageId: number;
}

function makeBot(): MockBot {
  const voice: SendCall[] = [];
  const photo: SendCall[] = [];
  const document: SendCall[] = [];
  const reactions: ReactionCall[] = [];
  const chatActions: ChatActionCall[] = [];
  const renames: RenameTopicCall[] = [];
  const state: MockBot = {
    bot: undefined as unknown as Bot,
    voice,
    photo,
    document,
    reactions,
    chatActions,
    renames,
    failNext: {},
    nextMessageId: 100,
  };
  const handleSend = (
    bucket: SendCall[],
    failKey: keyof MockBot["failNext"],
  ) =>
    async (chatId: number | string, file: InputFile, other?: { caption?: string }) => {
      if (state.failNext[failKey] !== undefined) {
        const err = state.failNext[failKey];
        state.failNext[failKey] = undefined;
        throw err;
      }
      bucket.push({ chatId, file, other });
      return { message_id: ++state.nextMessageId };
    };
  const bot = {
    api: {
      sendVoice: handleSend(voice, "voice"),
      sendPhoto: handleSend(photo, "photo"),
      sendDocument: handleSend(document, "document"),
      setMessageReaction: async (
        chatId: number | string,
        messageId: number,
        reaction: { type: "emoji"; emoji: string }[],
      ) => {
        if (state.failNext.reaction !== undefined) {
          const err = state.failNext.reaction;
          state.failNext.reaction = undefined;
          throw err;
        }
        reactions.push({ chatId, messageId, reaction });
        return true;
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
      editForumTopic: async (
        chatId: number | string,
        topicId: number,
        other: { name?: string },
      ) => {
        if (state.failNext.rename !== undefined) {
          const err = state.failNext.rename;
          state.failNext.rename = undefined;
          throw err;
        }
        renames.push({ chatId, topicId, title: other.name ?? "" });
        return true;
      },
    },
  } as unknown as Bot;
  state.bot = bot;
  return state;
}

function withTempFile<T>(name: string, contents: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "goblin-tools-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function getText(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0]!;
  return first.type === "text" ? (first.text ?? "") : "";
}

describe("createSendVoiceTool", () => {
  it("schema does not expose chatId", () => {
    const { bot } = makeBot();
    const tool = createSendVoiceTool(bot, 123);
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty("chatId");
    expect(schema.properties).toHaveProperty("voiceFile");
    expect(schema.properties).toHaveProperty("caption");
  });

  it("calls bot.api.sendVoice with bound chatId and InputFile, returns ok+messageId", async () => {
    const mock = makeBot();
    const tool = createSendVoiceTool(mock.bot, 123);
    await withTempFile("voice.ogg", "fake-ogg-bytes", async (path) => {
      const result = await tool.execute(
        "call-1",
        { voiceFile: path, caption: "hi" },
        undefined,
        undefined,
        {} as never,
      );
      expect(mock.voice).toHaveLength(1);
      const call = mock.voice[0]!;
      expect(call.chatId).toBe(123);
      expect(call.file).toBeInstanceOf(InputFile);
      expect(call.other).toEqual({ caption: "hi" });
      expect(JSON.parse(getText(result))).toEqual({ ok: true, messageId: 101 });
    });
  });

  it("omits caption from API call when not provided", async () => {
    const mock = makeBot();
    const tool = createSendVoiceTool(mock.bot, 999);
    await withTempFile("voice.ogg", "fake", async (path) => {
      await tool.execute("call-1", { voiceFile: path }, undefined, undefined, {} as never);
      expect(mock.voice[0]!.other).toEqual({});
    });
  });

  it("returns structured error when file does not exist", async () => {
    const mock = makeBot();
    const tool = createSendVoiceTool(mock.bot, 123);
    const result = await tool.execute(
      "call-1",
      { voiceFile: "/nonexistent/path/voice.ogg" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.voice).toHaveLength(0);
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("voiceFile does not exist");
  });

  it("returns structured error when bot.api.sendVoice throws", async () => {
    const mock = makeBot();
    mock.failNext.voice = new Error("network down");
    const tool = createSendVoiceTool(mock.bot, 123);
    await withTempFile("voice.ogg", "fake", async (path) => {
      const result = await tool.execute(
        "call-1",
        { voiceFile: path },
        undefined,
        undefined,
        {} as never,
      );
      const parsed = JSON.parse(getText(result));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Telegram API error");
      expect(parsed.error).toContain("network down");
    });
  });
});

describe("createSendPhotoTool", () => {
  it("schema does not expose chatId", () => {
    const { bot } = makeBot();
    const tool = createSendPhotoTool(bot, 123);
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty("chatId");
    expect(schema.properties).toHaveProperty("photoFile");
    expect(schema.properties).toHaveProperty("caption");
  });

  it("calls bot.api.sendPhoto with bound chatId and InputFile + caption", async () => {
    const mock = makeBot();
    const tool = createSendPhotoTool(mock.bot, 555);
    await withTempFile("img.jpg", "fake-jpg", async (path) => {
      const result = await tool.execute(
        "call-1",
        { photoFile: path, caption: "Screenshot" },
        undefined,
        undefined,
        {} as never,
      );
      expect(mock.photo).toHaveLength(1);
      const call = mock.photo[0]!;
      expect(call.chatId).toBe(555);
      expect(call.file).toBeInstanceOf(InputFile);
      expect(call.other).toEqual({ caption: "Screenshot" });
      expect(JSON.parse(getText(result))).toEqual({ ok: true, messageId: 101 });
    });
  });

  it("returns structured error when file does not exist", async () => {
    const mock = makeBot();
    const tool = createSendPhotoTool(mock.bot, 1);
    const result = await tool.execute(
      "call-1",
      { photoFile: "/nonexistent/img.jpg" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.photo).toHaveLength(0);
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("photoFile does not exist");
  });

  it("returns structured error when bot.api.sendPhoto throws", async () => {
    const mock = makeBot();
    mock.failNext.photo = new Error("rate limited");
    const tool = createSendPhotoTool(mock.bot, 1);
    await withTempFile("img.jpg", "x", async (path) => {
      const result = await tool.execute(
        "call-1",
        { photoFile: path },
        undefined,
        undefined,
        {} as never,
      );
      const parsed = JSON.parse(getText(result));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Telegram API error");
      expect(parsed.error).toContain("rate limited");
    });
  });
});

describe("createSendDocumentTool", () => {
  it("schema does not expose chatId", () => {
    const { bot } = makeBot();
    const tool = createSendDocumentTool(bot, 123);
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty("chatId");
    expect(schema.properties).toHaveProperty("documentFile");
    expect(schema.properties).toHaveProperty("caption");
  });

  it("calls bot.api.sendDocument with bound chatId and InputFile + caption", async () => {
    const mock = makeBot();
    const tool = createSendDocumentTool(mock.bot, 777);
    await withTempFile("data.json", "{}", async (path) => {
      const result = await tool.execute(
        "call-1",
        { documentFile: path, caption: "Data" },
        undefined,
        undefined,
        {} as never,
      );
      expect(mock.document).toHaveLength(1);
      const call = mock.document[0]!;
      expect(call.chatId).toBe(777);
      expect(call.file).toBeInstanceOf(InputFile);
      expect(call.other).toEqual({ caption: "Data" });
      expect(JSON.parse(getText(result))).toEqual({ ok: true, messageId: 101 });
    });
  });

  it("omits caption from API call when not provided", async () => {
    const mock = makeBot();
    const tool = createSendDocumentTool(mock.bot, 8);
    await withTempFile("data.json", "{}", async (path) => {
      await tool.execute("call-1", { documentFile: path }, undefined, undefined, {} as never);
      expect(mock.document[0]!.other).toEqual({});
    });
  });

  it("returns structured error when file does not exist", async () => {
    const mock = makeBot();
    const tool = createSendDocumentTool(mock.bot, 1);
    const result = await tool.execute(
      "call-1",
      { documentFile: "/nonexistent/data.json" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.document).toHaveLength(0);
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("documentFile does not exist");
  });

  it("returns structured error when bot.api.sendDocument throws", async () => {
    const mock = makeBot();
    mock.failNext.document = new Error("file too large");
    const tool = createSendDocumentTool(mock.bot, 1);
    await withTempFile("data.json", "{}", async (path) => {
      const result = await tool.execute(
        "call-1",
        { documentFile: path },
        undefined,
        undefined,
        {} as never,
      );
      const parsed = JSON.parse(getText(result));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Telegram API error");
      expect(parsed.error).toContain("file too large");
    });
  });
});

describe("createReactTool", () => {
  it("returns null when messageId is undefined", () => {
    const { bot } = makeBot();
    expect(createReactTool(bot, 123, undefined)).toBeNull();
  });

  it("returns a ToolDefinition when messageId is provided", () => {
    const { bot } = makeBot();
    const tool = createReactTool(bot, 123, 789);
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("react");
  });

  it("schema does not expose chatId or messageId", () => {
    const { bot } = makeBot();
    const tool = createReactTool(bot, 123, 789)!;
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("chatId");
    expect(schema.properties).not.toHaveProperty("messageId");
    expect(schema.properties).toHaveProperty("emoji");
  });

  it("calls bot.api.setMessageReaction with bound chatId and messageId", async () => {
    const mock = makeBot();
    const tool = createReactTool(mock.bot, 123, 789)!;
    const result = await tool.execute(
      "call-1",
      { emoji: "👍" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.reactions).toHaveLength(1);
    const call = mock.reactions[0]!;
    expect(call.chatId).toBe(123);
    expect(call.messageId).toBe(789);
    expect(call.reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
    expect(JSON.parse(getText(result))).toEqual({ ok: true });
  });

  it("returns structured error when emoji is not a single emoji char", async () => {
    const mock = makeBot();
    const tool = createReactTool(mock.bot, 123, 789)!;
    const result = await tool.execute(
      "call-1",
      { emoji: "thumbs_up" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.reactions).toHaveLength(0);
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("emoji must be a single emoji character");
  });

  it("accepts flag emojis (multi-codepoint Regional Indicators)", async () => {
    const mock = makeBot();
    const tool = createReactTool(mock.bot, 123, 789)!;
    const result = await tool.execute(
      "call-1",
      { emoji: "🇺🇸" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.reactions).toHaveLength(1);
    const call = mock.reactions[0]!;
    expect(call.reaction).toEqual([{ type: "emoji", emoji: "🇺🇸" }]);
    expect(JSON.parse(getText(result))).toEqual({ ok: true });
  });

  it("accepts ZWJ sequence emojis like family", async () => {
    const mock = makeBot();
    const tool = createReactTool(mock.bot, 123, 789)!;
    const result = await tool.execute(
      "call-1",
      { emoji: "👨‍👩‍👧‍👦" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.reactions).toHaveLength(1);
    const call = mock.reactions[0]!;
    expect(call.reaction).toEqual([{ type: "emoji", emoji: "👨‍👩‍👧‍👦" }]);
    expect(JSON.parse(getText(result))).toEqual({ ok: true });
  });

  it("rejects multiple emojis", async () => {
    const mock = makeBot();
    const tool = createReactTool(mock.bot, 123, 789)!;
    const result = await tool.execute(
      "call-1",
      { emoji: "👍🔥" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.reactions).toHaveLength(0);
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("emoji must be a single emoji character");
  });

  it("returns structured error when bot.api.setMessageReaction throws", async () => {
    const mock = makeBot();
    mock.failNext.reaction = new Error("not allowed");
    const tool = createReactTool(mock.bot, 123, 789)!;
    const result = await tool.execute(
      "call-1",
      { emoji: "🔥" },
      undefined,
      undefined,
      {} as never,
    );
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Telegram API error");
    expect(parsed.error).toContain("not allowed");
  });
});

describe("createChatActionTool", () => {
  it("schema does not expose chatId", () => {
    const { bot } = makeBot();
    const tool = createChatActionTool(bot, 123);
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("chatId");
    expect(schema.properties).toHaveProperty("action");
  });

  it("calls bot.api.sendChatAction with bound chatId and action", async () => {
    const mock = makeBot();
    const tool = createChatActionTool(mock.bot, 555);
    const result = await tool.execute(
      "call-1",
      { action: "typing" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.chatActions).toHaveLength(1);
    const call = mock.chatActions[0]!;
    expect(call.chatId).toBe(555);
    expect(call.action).toBe("typing");
    expect(JSON.parse(getText(result))).toEqual({ ok: true });
  });

  it("returns structured error when bot.api.sendChatAction throws", async () => {
    const mock = makeBot();
    mock.failNext.chatAction = new Error("flood");
    const tool = createChatActionTool(mock.bot, 1);
    const result = await tool.execute(
      "call-1",
      { action: "upload_document" },
      undefined,
      undefined,
      {} as never,
    );
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Telegram API error");
    expect(parsed.error).toContain("flood");
  });
});

describe("createRenameTopicTool", () => {
  it("returns null when topicId is undefined (DM)", () => {
    const { bot } = makeBot();
    expect(createRenameTopicTool(bot, 123, undefined)).toBeNull();
  });

  it("returns a ToolDefinition when topicId is provided", () => {
    const { bot } = makeBot();
    const tool = createRenameTopicTool(bot, 123, 5);
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("rename_topic");
  });

  it("schema does not expose chatId or topicId", () => {
    const { bot } = makeBot();
    const tool = createRenameTopicTool(bot, 123, 5)!;
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("chatId");
    expect(schema.properties).not.toHaveProperty("topicId");
    expect(schema.properties).toHaveProperty("title");
  });

  it("calls bot.api.setForumTopicTitle with bound chatId and topicId", async () => {
    const mock = makeBot();
    const tool = createRenameTopicTool(mock.bot, 123, 5)!;
    const result = await tool.execute(
      "call-1",
      { title: "New Topic Name" },
      undefined,
      undefined,
      {} as never,
    );
    expect(mock.renames).toHaveLength(1);
    const call = mock.renames[0]!;
    expect(call.chatId).toBe(123);
    expect(call.topicId).toBe(5);
    expect(call.title).toBe("New Topic Name");
    expect(JSON.parse(getText(result))).toEqual({ ok: true });
  });

  it("returns structured error when bot.api.setForumTopicTitle throws", async () => {
    const mock = makeBot();
    mock.failNext.rename = new Error("not admin");
    const tool = createRenameTopicTool(mock.bot, 123, 5)!;
    const result = await tool.execute(
      "call-1",
      { title: "Whatever" },
      undefined,
      undefined,
      {} as never,
    );
    const parsed = JSON.parse(getText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Telegram API error");
    expect(parsed.error).toContain("not admin");
  });
});
