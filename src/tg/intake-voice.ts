import type { Bot } from "grammy";
import { log } from "../log.ts";
import { transcribeWithGroq } from "../asr/mod.ts";
import { completed, type AdmissionResult } from "../shutdown/mod.ts";
import { saveAttachment, type SavedAttachment } from "./attachments.ts";
import { sendSystemReply } from "./format.ts";
import type { TelegramIntakeMessage, TelegramVoiceInput } from "./intake.ts";
import { downloadFileBytes } from "./intake-download.ts";
import {
  recordAssistantReply,
  resolveActiveTurn,
  runPrompt,
  type IntakeDeps,
} from "./intake-turn.ts";

export function createVoiceHandler(deps: IntakeDeps) {
  return async function handleVoice(
    message: TelegramIntakeMessage,
    api: Bot["api"],
    voice: TelegramVoiceInput,
  ): Promise<AdmissionResult<void>> {
    const turn = await resolveActiveTurn(deps, message, "voice");
    if (!turn) return completed(undefined);

    return turn.schedule(
      async (runner, authority) => {
        // Groq ASR setup gate: missing key fails at use time with a clear
        // message rather than at startup. Checked inside the scheduled task so
        // the reply respects the stale-runner guard and stays non-blocking.
        if (!deps.cfg.groqApiKey) {
          if (!authority.isCurrent()) return;
          const replyText = "Groq ASR is not configured. Add a Groq API key to transcribe voice messages.";
          await sendSystemReply(message, replyText, "warn");
          recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          return;
        }

        // One download serves both ASR and optional project-file saving, so a
        // failure here short-circuits before either side effect.
        const raw = await downloadFileBytes(api, voice.fileId, deps.cfg.botToken);
        if (!authority.isCurrent()) return;
        if (!raw) {
          if (authority.isCurrent()) {
            const replyText = "Sorry, I couldn't download that voice message.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        // Telegram voice messages are OGG Opus; default to audio/ogg when the
        // field is absent rather than rejecting the message.
        const mimeType = voice.mimeType ?? "audio/ogg";
        const asrResult = await transcribeWithGroq({
          audioBytes: raw,
          mimeType,
          model: deps.cfg.asrModel ?? "whisper-large-v3-turbo",
          apiKey: deps.cfg.groqApiKey,
        });
        if (!authority.isCurrent()) return;

        if (!asrResult.ok) {
          // Transport/API failure only; the sanitized error carries no secrets.
          log.warn("voice transcription failed", { error: asrResult.error, sessionId: turn.session.id });
          if (authority.isCurrent()) {
            const replyText = "Sorry, I couldn't transcribe that voice message.";
            await sendSystemReply(message, replyText, "error");
            recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        // Intake owns the semantic empty-text check: a successful HTTP response
        // with no speech is not an ASR failure.
        if (asrResult.text.length === 0) {
          if (authority.isCurrent()) {
            const replyText = "No speech was detected in that voice message.";
            await sendSystemReply(message, replyText, "info");
            recordAssistantReply(deps.cfg, turn.session.id, turn.surface, runner, replyText);
          }
          return;
        }

        // Transcription succeeded with text. Save the original voice file and
        // append a saved-file note alongside the transcript.
        const ext = mimeType === "audio/ogg" ? "oga" : "bin";
        const desiredName = `voice-${Date.now()}.${ext}`;

        let saved: SavedAttachment;
        try {
          if (!authority.isCurrent()) return;
          saved = saveAttachment(turn.environment, deps.cfg.goblinHome, desiredName, raw);
        } catch (err) {
          log.error("failed to save voice attachment", {
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
        const promptText = `[Voice message transcript]\n${asrResult.text}\n\n[Voice file \`${escapedPath}\` saved.]`;

        if (!authority.isCurrent()) return;
        await runPrompt(deps, message, turn.surface, runner, turn.session, promptText);
      },
      "runner voice prompt failed",
    );
  };
}
