import { InputFile, type Api } from "grammy";
import type { TtsConfig } from "../config-schema.ts";
import type { ConversationReads } from "../conversation-read.ts";
import { speakable } from "../agent/tts.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";

// Callback-data id of the 🔊 button the delivery sink attaches to voice-capable replies.
export const SPEAK_CALLBACK = "speak_reply";

export interface SpeakQuery {
	id: string;
	message?: {
		message_id: number;
		chat: { id: number };
		message_thread_id?: number;
		text?: string;
	};
}

const inFlight = new Set<string>();

export interface SpeakButtonDeps {
	api: Api;
	tts: TtsConfig | undefined;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
	// Durable bubble→reply lookup — the delivery sink records each
	// landed message id against its reply event at finalize.
	store: Pick<ConversationReads, "deliveredReplyText">;
}

export async function handleSpeakButton(query: SpeakQuery, deps: SpeakButtonDeps): Promise<void> {
	try {
		await speak(query, deps);
	} catch (err) {
		log.error("voice button handler failed", err, { query: query.id });
		await withTimeout(
			deps.api.answerCallbackQuery(query.id, { text: "internal error" }),
			"answerCallbackQuery",
		).catch((e: unknown) => log.debug("answerCallbackQuery failed", { error: String(e) }));
	}
}

async function speak(query: SpeakQuery, deps: SpeakButtonDeps): Promise<void> {
	const message = query.message;
	const answer = (text?: string) =>
		withTimeout(
			text === undefined
				? deps.api.answerCallbackQuery(query.id)
				: deps.api.answerCallbackQuery(query.id, { text }),
			"answerCallbackQuery",
		).catch((err: unknown) => {
			log.debug("answerCallbackQuery failed", { error: String(err) });
		});

	if (!deps.tts) {
		await answer("speech is not configured");
		return;
	}
	if (!message) {
		await answer("nothing to speak here");
		return;
	}
	const key = `${message.chat.id}:${message.message_id}`;
	if (inFlight.has(key)) {
		await answer("already reading this reply");
		return;
	}
	inFlight.add(key);
	try {
		const full = deps.store.deliveredReplyText(message.chat.id, message.message_id);
		const tapped = "text" in message ? (message.text ?? "") : "";
		if (full === null) {
			log.warn("voice button reply lookup miss", {
				chat: message.chat.id,
				message: message.message_id,
			});
		}
		const text = speakable(full ?? tapped);
		if (text === "") {
			await answer("nothing speakable in this reply");
			return;
		}
		await answer();
		const thread =
			message.message_thread_id !== undefined
				? { message_thread_id: message.message_thread_id }
				: {};
		const action = () =>
			withTimeout(
				deps.api.sendChatAction(message.chat.id, "record_voice", { ...thread }),
				"sendChatAction",
			).catch((err: unknown) => log.debug("record voice ping failed", { error: String(err) }));
		action();
		const recording = setInterval(action, 4_000);
		try {
			const audio = await deps.synthesize(text, deps.tts);
			clearInterval(recording);
			for (const chunk of audio) {
				await withTimeout(
					deps.api.sendVoice(message.chat.id, new InputFile(chunk, "speech.ogg"), { ...thread }),
					"sendVoice",
				);
			}
			// The bubble was read but the full reply wasn't reachable —
			// say so where the tap happened, same thread.
			if (full === null) {
				await withTimeout(
					deps.api.sendMessage(
						message.chat.id,
						"Only this part could be read — the full reply is no longer available.",
						{ ...thread },
					),
					"sendMessage",
				).catch((err: unknown) =>
					log.debug("partial-reply notice failed", { error: String(err) }),
				);
			}
			log.info("voice button delivered", {
				chat: message.chat.id,
				message: message.message_id,
				chunks: audio.length,
			});
		} catch (err) {
			clearInterval(recording);
			log.warn("voice button failed", err, {
				chat: message.chat.id,
				message: message.message_id,
			});
			await withTimeout(
				deps.api.sendMessage(message.chat.id, "⚠ speech failed — check the log", { ...thread }),
				"sendMessage",
			).catch((err2: unknown) => log.warn("voice button failure notice failed", err2));
		}
	} finally {
		inFlight.delete(key);
	}
}
