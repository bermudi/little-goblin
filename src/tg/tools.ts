import { existsSync } from "node:fs";
import { Bot, InputFile } from "grammy";
import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReactionType } from "@grammyjs/types";

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

const reactSchema = Type.Object({
  emoji: Type.String({ description: "A single emoji character (including flag emojis and ZWJ sequences like 👨‍👩‍👧‍👦)" }),
});

const renameTopicSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
});

const chatActionSchema = Type.Object({
  action: Type.Union([
    Type.Literal("typing"),
    Type.Literal("upload_photo"),
    Type.Literal("record_voice"),
    Type.Literal("upload_document"),
  ]),
});

type SendVoiceInput = Static<typeof sendVoiceSchema>;

export function createSendVoiceTool(bot: Bot, chatId: number): ToolDefinition {
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
          params.caption !== undefined ? { caption: params.caption } : {},
        );
        return jsonResult({ ok: true, messageId: result.message_id });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}

type SendPhotoInput = Static<typeof sendPhotoSchema>;

export function createSendPhotoTool(bot: Bot, chatId: number): ToolDefinition {
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
          params.caption !== undefined ? { caption: params.caption } : {},
        );
        return jsonResult({ ok: true, messageId: result.message_id });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}

type SendDocumentInput = Static<typeof sendDocumentSchema>;

export function createSendDocumentTool(bot: Bot, chatId: number): ToolDefinition {
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
          params.caption !== undefined ? { caption: params.caption } : {},
        );
        return jsonResult({ ok: true, messageId: result.message_id });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}

type ReactInput = Static<typeof reactSchema>;

function isSingleEmoji(s: string): boolean {
  // Use Intl.Segmenter to properly count grapheme clusters (user-perceived characters).
  // This handles multi-codepoint emojis like flags (🇺🇸) and ZWJ sequences (👨‍👩‍👧‍👦).
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const segments = Array.from(segmenter.segment(s));
  if (segments.length !== 1) return false;
  const segment = segments[0]!.segment;
  // Verify the grapheme contains at least one emoji codepoint.
  // Multi-codepoint emojis (flags, ZWJ sequences) won't match ^\p{Emoji}$ but contain emoji codepoints.
  return /\p{Emoji}/u.test(segment);
}

export function createReactTool(
  bot: Bot,
  chatId: number,
  messageId: number | undefined,
): ToolDefinition | null {
  if (messageId === undefined) return null;
  return defineTool({
    name: "react",
    label: "React",
    description: "Add an emoji reaction to the message that triggered this turn.",
    parameters: reactSchema,
    async execute(_toolCallId, params: ReactInput) {
      if (!isSingleEmoji(params.emoji)) {
        return jsonResult({ ok: false, error: "emoji must be a single emoji character" });
      }
      try {
        // Telegram restricts reaction emoji to a fixed set; we trust the regex check
        // above and let the API reject any disallowed emoji at runtime.
        const reaction = [{ type: "emoji" as const, emoji: params.emoji }];
        await bot.api.setMessageReaction(chatId, messageId, reaction as ReactionType[]);
        return jsonResult({ ok: true });
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

type ChatActionInput = Static<typeof chatActionSchema>;

export function createChatActionTool(bot: Bot, chatId: number): ToolDefinition {
  return defineTool({
    name: "chat_action",
    label: "Chat Action",
    description: "Set a transient chat action (typing, recording, uploading) on the active chat.",
    parameters: chatActionSchema,
    async execute(_toolCallId, params: ChatActionInput) {
      try {
        await bot.api.sendChatAction(chatId, params.action);
        return jsonResult({ ok: true });
      } catch (err) {
        return jsonResult({ ok: false, error: `Telegram API error: ${errorMessage(err)}` });
      }
    },
  });
}
