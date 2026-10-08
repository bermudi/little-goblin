// The 🔊 inline button on a finished reply: one tap → the whole reply
// spoken as voice notes. Extracted from mod.ts so its boundaries —
// callback answering, double-tap guarding, failure surfacing — are
// testable without a live bot.

import { InputFile, type Api } from "grammy";
import type { TtsConfig } from "../config.ts";
import { speakable } from "../agent/tts.ts";
import { log } from "../log.ts";
import { recentReplyText } from "./delivery.ts";
import { withTimeout } from "./deadline.ts";

// Structural subset of Telegram's CallbackQuery — the fields this flow
// reads. grammy's full type is assignable to it, and importing raw wire
// types would pull an undeclared dependency.
export interface SpeakQuery {
	id: string;
	message?: {
		message_id: number;
		chat: { id: number };
		message_thread_id?: number;
		text?: string;
	};
}

// One in-flight rendering per message: a double-tap used to synthesize
// and deliver the reply twice.
const inFlight = new Set<string>();

export interface SpeakButtonDeps {
	api: Api;
	// Read per tap by the caller — a mini-app save applies without restart.
	tts: TtsConfig | undefined;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
}

export async function handleSpeakButton(query: SpeakQuery, deps: SpeakButtonDeps): Promise<void> {
	try {
		await speak(query, deps);
	} catch (err) {
		// Outside the guarded boundaries below — a programming error, not
		// an edge failure. The fire-and-forget registration can't surface
		// it, so it lands here instead of unhandledRejection.
		log.error("voice button handler failed", err, { query: query.id });
	}
}

async function speak(query: SpeakQuery, deps: SpeakButtonDeps): Promise<void> {
	const message = query.message;
	// Answer the tap exactly once, immediately: Telegram expires callback
	// queries in seconds, and an answer attempted after synthesis and
	// uploads either fails ("query too old") or reads as a false failure
	// while the voice notes arrive fine. Outcomes surface in the chat.
	const answer = (text?: string) =>
		withTimeout(
			text === undefined
				? deps.api.answerCallbackQuery(query.id)
				: deps.api.answerCallbackQuery(query.id, { text }),
			"answerCallbackQuery",
		).catch((err: unknown) => {
			// Client already gave up waiting — cosmetic, and the real
			// outcome rides the chat.
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
		const full = recentReplyText(message.chat.id, message.message_id);
		const tapped = "text" in message ? (message.text ?? "") : "";
		if (full === null) {
			log.warn("voice button reply cache miss", {
				chat: message.chat.id,
				message: message.message_id,
			});
		}
		const text = speakable(full ?? tapped);
		if (text === "") {
			await answer("nothing speakable in this reply");
			return;
		}
		// Spinner off before the slow part.
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
			log.info("voice button delivered", {
				chat: message.chat.id,
				message: message.message_id,
				chunks: audio.length,
			});
		} catch (err) {
			clearInterval(recording);
			log.warn("voice button failed", {
				chat: message.chat.id,
				message: message.message_id,
				error: String(err),
			});
			// The tap was already answered — no toast can carry this. The
			// failure lands in the chat, where the operator is watching
			// for voice notes that never came. Synthesis or delivery — the
			// log line carries the which.
			await withTimeout(
				deps.api.sendMessage(message.chat.id, "⚠ speech failed — check the log", { ...thread }),
				"sendMessage",
			).catch((err2: unknown) =>
				log.warn("voice button failure notice failed", { error: String(err2) }),
			);
		}
	} finally {
		inFlight.delete(key);
	}
}
