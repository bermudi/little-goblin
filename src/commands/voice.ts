import { readFile, unlink } from "node:fs/promises";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import { transcriptPath } from "../sessions/paths.ts";
import { edgeTts, resolveVoiceName, voiceTmpPath } from "../voice.ts";

export interface ExecuteVoiceOpts {
  home: string;
  sessionId: string;
  bot: Bot;
  chatId: number;
  topicId?: number;
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

export async function executeVoice(opts: ExecuteVoiceOpts): Promise<VoiceResult> {
  const text = await readLastAssistantMessage(opts.home, opts.sessionId);
  if (text === null) {
    return { kind: "no-messages" };
  }

  const tmpPath = voiceTmpPath();
  try {
    await edgeTts(text, resolveVoiceName(), tmpPath);
    await opts.bot.api.sendVoice(
      opts.chatId,
      new InputFile(tmpPath),
      opts.topicId !== undefined ? { message_thread_id: opts.topicId } : {},
    );
    return { kind: "sent" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { kind: "tts-failed", error };
  } finally {
    await unlink(tmpPath).catch((unlinkErr: unknown) => {
      if (isNodeError(unlinkErr) && unlinkErr.code === "ENOENT") return;
      throw unlinkErr;
    });
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
