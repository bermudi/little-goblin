import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Bot, InputFile } from "grammy";
import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { edgeTts, resolveVoiceName, voiceTmpPath } from "../voice.ts";

function jsonResult(value: unknown): {
  content: { type: "text"; text: string }[];
  details: undefined;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const sendVoiceSchema = Type.Object({
  voiceFile: Type.String({ description: "Absolute path to the voice file" }),
  caption: Type.Optional(Type.String()),
});

const sendPhotoSchema = Type.Object({
  photoFile: Type.String({ description: "Absolute path to the image file" }),
  caption: Type.Optional(Type.String()),
});

const sendDocumentSchema = Type.Object({
  documentFile: Type.String({ description: "Absolute path to the document file" }),
  caption: Type.Optional(Type.String()),
});

const renameTopicSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
});

const textToSpeechSchema = Type.Object({
  text: Type.Optional(Type.String()),
  file: Type.Optional(Type.String()),
});

type TextToSpeechInput = Static<typeof textToSpeechSchema>;

export function createTextToSpeechTool(opts: { voiceName?: string } = {}): ToolDefinition {
  return defineTool({
    name: "text_to_speech",
    label: "Text to Speech",
    description: "Convert text to speech using Microsoft Edge TTS. Returns the path to the generated MP3 file. Chain with send_voice to deliver.",
    parameters: textToSpeechSchema,
    async execute(_toolCallId, params: TextToSpeechInput) {
      const source = await resolveTextToSpeechSource(params);
      if (!source.ok) return jsonResult(source);

      const audioPath = voiceTmpPath();
      const voiceName = opts.voiceName ?? resolveVoiceName();
      try {
        await edgeTts(source.text, voiceName, audioPath);
        return jsonResult({ ok: true, audioPath });
      } catch (err) {
        return jsonResult({ ok: false, error: `TTS generation failed: ${errorMessage(err)}` });
      }
    },
  });
}

async function resolveTextToSpeechSource(params: TextToSpeechInput): Promise<
  | { ok: true; text: string }
  | { ok: false; error: string }
> {
  if (params.text !== undefined) return { ok: true, text: params.text };
  if (params.file === undefined) return { ok: false, error: "either text or file is required" };
  if (!existsSync(params.file)) return { ok: false, error: `file does not exist: ${params.file}` };
  try {
    return { ok: true, text: await readFile(params.file, "utf8") };
  } catch (err) {
    return { ok: false, error: `failed to read file: ${errorMessage(err)}` };
  }
}

type SendVoiceInput = Static<typeof sendVoiceSchema>;

export function createSendVoiceTool(bot: Bot, chatId: number, topicId?: number): ToolDefinition {
  return defineTool({
    name: "send_voice",
    label: "Send Voice",
    description: "Send a voice message to the active chat.",
    parameters: sendVoiceSchema,
    async execute(_toolCallId, params: SendVoiceInput) {
      if (!existsSync(params.voiceFile)) {
        return jsonResult({ ok: false, error: `voiceFile does not exist: ${params.voiceFile}` });
      }
      try {
        const result = await bot.api.sendVoice(
          chatId,
          new InputFile(params.voiceFile),
          {
            ...(params.caption !== undefined ? { caption: params.caption } : {}),
            ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
          },
        );
        return jsonResult({ ok: true, messageId: result.message_id });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}

type SendPhotoInput = Static<typeof sendPhotoSchema>;

export function createSendPhotoTool(bot: Bot, chatId: number, topicId?: number): ToolDefinition {
  return defineTool({
    name: "send_photo",
    label: "Send Photo",
    description: "Send an image to the active chat.",
    parameters: sendPhotoSchema,
    async execute(_toolCallId, params: SendPhotoInput) {
      if (!existsSync(params.photoFile)) {
        return jsonResult({ ok: false, error: `photoFile does not exist: ${params.photoFile}` });
      }
      try {
        const result = await bot.api.sendPhoto(
          chatId,
          new InputFile(params.photoFile),
          {
            ...(params.caption !== undefined ? { caption: params.caption } : {}),
            ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
          },
        );
        return jsonResult({ ok: true, messageId: result.message_id });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}

type SendDocumentInput = Static<typeof sendDocumentSchema>;

export function createSendDocumentTool(bot: Bot, chatId: number, topicId?: number): ToolDefinition {
  return defineTool({
    name: "send_document",
    label: "Send Document",
    description: "Send a file to the active chat.",
    parameters: sendDocumentSchema,
    async execute(_toolCallId, params: SendDocumentInput) {
      if (!existsSync(params.documentFile)) {
        return jsonResult({
          ok: false,
          error: `documentFile does not exist: ${params.documentFile}`,
        });
      }
      try {
        const result = await bot.api.sendDocument(
          chatId,
          new InputFile(params.documentFile),
          {
            ...(params.caption !== undefined ? { caption: params.caption } : {}),
            ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
          },
        );
        return jsonResult({ ok: true, messageId: result.message_id });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}

type RenameTopicInput = Static<typeof renameTopicSchema>;

export function createRenameTopicTool(
  bot: Bot,
  chatId: number,
  topicId: number | undefined,
): ToolDefinition | null {
  if (topicId === undefined) return null;
  return defineTool({
    name: "rename_topic",
    label: "Rename Topic",
    description: "Rename the active forum topic.",
    parameters: renameTopicSchema,
    async execute(_toolCallId, params: RenameTopicInput) {
      try {
        // grammy / Telegram Bot API exposes topic renaming via editForumTopic
        // with a `name` field, not a hypothetical setForumTopicTitle.
        await bot.api.editForumTopic(chatId, topicId, { name: params.title });
        return jsonResult({ ok: true });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}


