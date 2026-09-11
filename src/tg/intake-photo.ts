import type { Bot } from "grammy";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { completed, type AdmissionResult } from "../shutdown/mod.ts";
import { sendSystemReply } from "./format.ts";
import type { TelegramIntakeMessage } from "./intake.ts";
import { downloadPhoto } from "./intake-download.ts";
import {
  recordAssistantReply,
  resolveActiveTurn,
  runPrompt,
  type IntakeDeps,
} from "./intake-turn.ts";

export function createPhotoHandler(deps: IntakeDeps) {
  return async function handlePhoto(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    fileIds: string[],
    caption?: string,
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(deps, message, "photo");
    if (!turn) return completed(undefined);

    return turn.schedule(
      async (runner, authority) => {
        const photo = await downloadPhoto(api, fileIds, deps.cfg.botToken);
        if (!authority.isCurrent()) return;
        if (!photo) {
          const replyText = "Sorry, I couldn't download that image.";
          await sendSystemReply(message, replyText, "error");
          recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          return;
        }

        const content: (TextContent | ImageContent)[] = [];
        if (caption) {
          content.push({ type: "text", text: caption });
        }
        content.push({ type: "image", data: photo.data, mimeType: photo.mimeType });

        if (!authority.isCurrent()) return;
        await runPrompt(deps, message, turn.surface, runner, turn.session, content);
      },
      "runner photo prompt failed",
      { replyModelNotCapable: true },
    );
  };
}
