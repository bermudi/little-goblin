import { readFile, unlink } from "node:fs/promises";
import type { Bot, Context } from "grammy";
import type { AgentRunner } from "../agent/mod.ts";
import type { Config } from "../config.ts";
import type { MemoryStore } from "../memory/mod.ts";
import { transcriptPath } from "../sessions/paths.ts";
import type { ChatLocator, SessionState } from "../sessions/types.ts";
import { MessageBuffer, type MessageBufferOptions } from "../tg/buffer.ts";
import { edgeTts, resolveVoiceName, voiceTmpPath } from "../voice.ts";

export interface VoiceMsgCtx {
  bot: Bot;
  memoryStore: MemoryStore;
  cfg: Config;
  getOrCreateRunner: (session: SessionState, locator: ChatLocator, ctx: Context) => AgentRunner;
}

export interface ExecuteVoiceOpts {
  home: string;
  sessionId: string;
  session: SessionState;
  locator: ChatLocator;
  ctx: Context;
  msgCtx: VoiceMsgCtx;
}

export type VoiceResult =
  | { kind: "sent" }
  | { kind: "no-messages" }
  | { kind: "tts-failed"; error: string };

function extractTextFromAssistantContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text.length > 0 ? text : null;
}

export async function readLastAssistantMessage(home: string, sessionId: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(home, sessionId), "utf-8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }

  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    return extractTextFromAssistantContent(record.content);
  }
  return null;
}

function buildSyntheticPrompt(audioPath: string): string {
  return `Audio for your last response is at \`${audioPath}\`. Use send_voice to send it to the user. Do not repeat or describe the content — the audio IS the message.`;
}

type MessageBufferOptionsWithTurnEnd = MessageBufferOptions & {
  onTurnEnd?: () => void | Promise<void>;
};

export async function executeVoice(opts: ExecuteVoiceOpts): Promise<VoiceResult> {
  const text = await readLastAssistantMessage(opts.home, opts.sessionId);
  if (text === null) {
    return { kind: "no-messages" };
  }

  const tmpPath = voiceTmpPath();
  const voice = resolveVoiceName();
  try {
    await edgeTts(text, voice, tmpPath);
  } catch (err) {
    await unlink(tmpPath).catch((unlinkErr: unknown) => {
      if (isNodeError(unlinkErr) && unlinkErr.code === "ENOENT") return;
      throw unlinkErr;
    });
    const error = err instanceof Error ? err.message : String(err);
    return { kind: "tts-failed", error };
  }

  const { bot, memoryStore, cfg, getOrCreateRunner } = opts.msgCtx;
  const { locator, ctx, session } = opts;
  const topicId = locator.topicId;

  const bufferOptions: MessageBufferOptionsWithTurnEnd = {
    visibility: cfg.toolVisibility,
    onTopicNotFound:
      topicId !== undefined
        ? async () => {
            await memoryStore.archiveOrphan(locator.chatId, topicId);
          }
        : undefined,
    onTurnEnd: () =>
      unlink(tmpPath).catch((unlinkErr: unknown) => {
        if (isNodeError(unlinkErr) && unlinkErr.code === "ENOENT") return;
        throw unlinkErr;
      }),
  };

  const buffer = new MessageBuffer(bot, locator.chatId, topicId, bufferOptions as MessageBufferOptions);
  const runner = getOrCreateRunner(session, locator, ctx);
  await runner.prompt(buildSyntheticPrompt(tmpPath), buffer);
  return { kind: "sent" };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
