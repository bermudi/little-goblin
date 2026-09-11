import type { Bot } from "grammy";
import { log } from "../log.ts";
import { completed, type AdmissionResult } from "../shutdown/mod.ts";
import { saveAttachment, UnsafeAttachmentNameError, type SavedAttachment } from "./attachments.ts";
import { sendSystemReply } from "./format.ts";
import type { TelegramAudioInput, TelegramIntakeMessage } from "./intake.ts";
import { downloadFileBytes } from "./intake-download.ts";
import {
  recordAssistantReply,
  resolveActiveTurn,
  runPrompt,
  type IntakeDeps,
} from "./intake-turn.ts";

export function createAudioHandler(deps: IntakeDeps) {
  return async function handleAudio(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    audio: TelegramAudioInput,
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(deps, message, "audio");
    if (!turn) return completed(undefined);

    return turn.schedule(
      async (runner, authority) => {
        const raw = await downloadFileBytes(api, audio.fileId, deps.cfg.botToken);
        if (!authority.isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that audio file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          return;
        }

        let desiredName = audio.fileName?.trim();
        if (!desiredName) {
          const title = [audio.performer, audio.title].filter(Boolean).join(" - ");
          desiredName = title ? `${title}.mp3` : `audio-${Date.now()}.mp3`;
        }

        let saved: SavedAttachment;
        try {
          if (!authority.isCurrent()) return;
          saved = saveAttachment(turn.environment, deps.cfg.goblinHome, desiredName, raw);
        } catch (err) {
          if (err instanceof UnsafeAttachmentNameError) {
            const replyText = "Rejected: unsafe filename.";
            if (authority.isCurrent()) {
              await sendSystemReply(message, replyText, "warn");
              recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
            }
            return;
          }
          log.error("failed to save audio attachment", {
            error: err instanceof Error ? err.message : String(err),
            fileName: desiredName,
            sessionId: turn.session.id,
          });
          if (authority.isCurrent()) {
            const replyText = `Failed to save ${desiredName}.`;
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        if (!authority.isCurrent()) return;
        await sendSystemReply(message, `Saved ${saved.relativePath}.`, "ok");

        const escapedPath = saved.relativePath.replace(/`/g, "'");
        const promptText = audio.caption
          ? `${audio.caption}\n\n[Audio file \`${escapedPath}\` saved.]`
          : `User uploaded audio \`${escapedPath}\`.`;

        if (!authority.isCurrent()) return;
        await runPrompt(deps, message, turn.surface, runner, turn.session, promptText);
      },
      "runner audio prompt failed",
    );
  };
}
