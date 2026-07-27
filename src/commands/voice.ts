import { unlink } from "node:fs/promises";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import { extractEntryText, readTranscriptEntries } from "../sessions/transcript.ts";
import { edgeTts, resolveVoiceName, voiceTmpPath } from "../voice.ts";
import { deliveryOpts } from "../tg/delivery.ts";
import type { Surface } from "../surface.ts";

export interface ExecuteVoiceOpts {
  home: string;
  sessionId: string;
  bot: Bot;
  surface: Surface;
}

export type VoiceResult =
  | { kind: "sent" }
  | { kind: "no-messages" }
  | { kind: "tts-failed"; error: string };

export async function readLastAssistantMessage(home: string, sessionId: string): Promise<string | null> {
  const entries = readTranscriptEntries(home, sessionId);
  for (let i = entries.length - 1; i >= 0; i--) {
    const { entry } = entries[i]!;
    if (entry === null || entry.role !== "assistant") continue;
    const text = extractEntryText(entry.content);
    if (text.length > 0) return text;
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
      opts.surface.chatId,
      new InputFile(tmpPath),
      deliveryOpts(opts.surface),
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
