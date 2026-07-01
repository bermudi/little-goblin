import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import {
  createTextToSpeechTool,
  createSendVoiceTool,
  createSendPhotoTool,
  createSendDocumentTool,
} from "./tools.ts";

interface SendCall {
  chatId: number | string;
  file: InputFile;
  other: { caption?: string } | undefined;
}

interface MockBot {
  bot: Bot;
  voice: SendCall[];
  photo: SendCall[];
  document: SendCall[];
  failNext: {
    voice?: unknown;
    photo?: unknown;
    document?: unknown;
  };
  nextMessageId: number;
}

function makeBot(): MockBot {
  const voice: SendCall[] = [];
  const photo: SendCall[] = [];
  const document: SendCall[] = [];
  const state: MockBot = {
    bot: undefined as unknown as Bot,
    voice,
    photo,
    document,
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
    },
  } as unknown as Bot;
  state.bot = bot;
  return state;
}

async function withTempFile<T>(name: string, contents: string, fn: (path: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "goblin-tools-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  try {
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function getText(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0]!;
  return first.type === "text" ? (first.text ?? "") : "";
}

function parseResult(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
  return JSON.parse(getText(result)) as Record<string, unknown>;
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

describe("createTextToSpeechTool", () => {
  it("has the expected tool metadata and schema", () => {
    const tool = createTextToSpeechTool();
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(tool.name).toBe("text_to_speech");
    expect(tool.label).toBe("Text to Speech");
    expect(tool.description).toContain("Convert text to speech");
    expect(schema.properties).toHaveProperty("text");
    expect(schema.properties).toHaveProperty("file");
    expect(schema.properties).not.toHaveProperty("chatId");
  });

  it("generates speech from text", async () => {
    const tool = createTextToSpeechTool();
    const result = parseResult(await tool.execute("call-1", { text: "hello" }, undefined, undefined, {} as never));
    try {
      expect(result.ok).toBe(true);
      expect(typeof result.audioPath).toBe("string");
      expect(existsSync(result.audioPath as string)).toBe(true);
    } finally {
      if (typeof result.audioPath === "string") unlinkIfExists(result.audioPath);
    }
  }, 60_000);

  it("generates speech from a file", async () => {
    const tool = createTextToSpeechTool();
    await withTempFile("speech.txt", "hello from file", async (path) => {
      const result = parseResult(await tool.execute("call-1", { file: path }, undefined, undefined, {} as never));
      try {
        expect(result.ok).toBe(true);
        expect(typeof result.audioPath).toBe("string");
        expect(existsSync(result.audioPath as string)).toBe(true);
      } finally {
        if (typeof result.audioPath === "string") unlinkIfExists(result.audioPath);
      }
    });
  }, 60_000);

  it("returns an error for nonexistent files", async () => {
    const tool = createTextToSpeechTool();
    const result = parseResult(await tool.execute("call-1", { file: "/nonexistent/file.txt" }, undefined, undefined, {} as never));
    expect(result).toEqual({ ok: false, error: "file does not exist: /nonexistent/file.txt" });
  });

  it("returns an error when neither text nor file is provided", async () => {
    const tool = createTextToSpeechTool();
    const result = parseResult(await tool.execute("call-1", {}, undefined, undefined, {} as never));
    expect(result).toEqual({ ok: false, error: "either text or file is required" });
  });

  it("prefers text over file when both are provided", async () => {
    const tool = createTextToSpeechTool();
    const result = parseResult(await tool.execute(
      "call-1",
      { text: "hello from text", file: "/nonexistent/file.txt" },
      undefined,
      undefined,
      {} as never,
    ));
    try {
      expect(result.ok).toBe(true);
      expect(typeof result.audioPath).toBe("string");
      expect(existsSync(result.audioPath as string)).toBe(true);
    } finally {
      if (typeof result.audioPath === "string") unlinkIfExists(result.audioPath);
    }
  }, 60_000);

  it("uses the voiceName override", async () => {
    const tool = createTextToSpeechTool({ voiceName: "test-voice" });
    const result = parseResult(await tool.execute("call-1", { text: "hello" }, undefined, undefined, {} as never));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("test-voice");
  }, 60_000);
});

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
