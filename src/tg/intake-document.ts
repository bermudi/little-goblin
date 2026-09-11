import type { Bot } from "grammy";
import { log } from "../log.ts";
import { completed, type AdmissionResult } from "../shutdown/mod.ts";
import { saveAttachment, UnsafeAttachmentNameError, type SavedAttachment } from "./attachments.ts";
import { sendSystemReply } from "./format.ts";
import type { TelegramDocumentInput, TelegramIntakeMessage } from "./intake.ts";
import { downloadFileBytes } from "./intake-download.ts";
import {
  recordAssistantReply,
  resolveActiveTurn,
  runPrompt,
  type IntakeDeps,
} from "./intake-turn.ts";

export function createDocumentHandler(deps: IntakeDeps) {
  return async function handleDocument(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    doc: TelegramDocumentInput,
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(deps, message, "document");
    if (!turn) return completed(undefined);

    return turn.schedule(
      async (runner, authority) => {
        const raw = await downloadFileBytes(api, doc.fileId, deps.cfg.botToken);
        if (!authority.isCurrent()) return;
        if (!raw) {
          const replyText = "Sorry, I couldn't download that file.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          return;
        }

        const desiredName = doc.fileName || "attachment";
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
          log.error("failed to save document attachment", {
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
        const promptText = doc.caption
          ? `${doc.caption}\n\n[File \`${escapedPath}\` saved.]`
          : `User uploaded \`${escapedPath}\`.`;

        if (!authority.isCurrent()) return;
        await runPrompt(deps, message, turn.surface, runner, turn.session, promptText);
      },
      "runner document prompt failed",
    );
  };
}
