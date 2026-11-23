import { InputFile, type Api } from "grammy";
import type { Conversation } from "../conversation-read.ts";
import type { TurnDone } from "../turn/sink.ts";
import { speechContent } from "../agent/tts.ts";
import { log } from "../log.ts";
import { every, type Timer } from "../timing.ts";
import { isParseEntitiesError } from "./delivery-errors.ts";
import {
	chunkWindows,
	TG_MESSAGE_LIMIT,
	TYPING_INTERVAL_MS,
} from "./delivery-text.ts";
import { renderWindow } from "./tg-html.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";

// The voice-note send and recording-indicator pieces of makeDeliverySink
// (#458). delivery.ts owns mutable turn state; this cluster reads it through
// live ctx accessors and changes shared recording/typing state through setters.
export interface VoiceDeliveryCtx {
	api: Api;
	conv: Conversation;
	voice?: { synthesize(text: string): Promise<Uint8Array[]> };
	text(): string;
	notifyUncertain(): Promise<void>;
	ackDropped(): Promise<void>;
	typingIntervalMs: number;
	enqueue(fn: () => Promise<void>): void;
	settled(): Promise<void>;
	mayDeliver(): boolean;
	uncertain(): boolean;
	markUncertain(error: unknown, kind: string): void;
	authoritative(): boolean;
	sinkDone(): boolean;
	repingTyping(): void;
	clearTyping(): void;
	startTyping(): void;
	recordingIntervals(): ReadonlySet<Timer>;
	addRecording(interval: Timer): void;
	removeRecording(interval: Timer): void;
	richMode(): boolean;
	refreshRichDrafts(): void;
}

export function makeVoiceDelivery(ctx: VoiceDeliveryCtx): {
	sendVoice(audio: Uint8Array): Promise<void>;
	sendRecording(): void;
	onVoiceNote(audio: Uint8Array): Promise<void>;
	onVoiceSynthesisStart(): () => void;
	onDone(done: TurnDone, notice: string | null): Promise<void>;
} {
	const { api, conv } = ctx;

	async function sendVoice(audio: Uint8Array): Promise<void> {
		if (ctx.uncertain()) {
			throw new Error(
				"Telegram delivery uncertain — voice not sent again; check Telegram before retrying",
			);
		}
		if (!ctx.mayDeliver()) return;
		let failure: { error: unknown } | undefined;
		ctx.enqueue(async () => {
			if (!ctx.mayDeliver()) return;
			try {
				const sent = await withTimeout(
					api.sendVoice(conv.chatId, new InputFile(audio, "speech.ogg"), {
						...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
					}),
					"sendVoice",
				);
				log.debug("voice delivered", {
					conversation: conv.id,
					message: sent.message_id,
					...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				});
			} catch (error) {
				if (error instanceof TelegramTimeoutError) ctx.markUncertain(error, "sendVoice");
				failure = { error };
				throw error;
			}
		});
		await ctx.settled();
		if (failure) throw failure.error;
		ctx.repingTyping();
		if (ctx.uncertain()) {
			throw new Error(
				"Telegram delivery uncertain — voice not sent again; check Telegram before retrying",
			);
		}
	}

	async function onVoiceNote(audio: Uint8Array): Promise<void> {
		sendRecording();
		await sendVoice(audio);
	}

	function sendRecording(): void {
		if (!ctx.authoritative()) return;
		withTimeout(
			api.sendChatAction(conv.chatId, "record_voice", {
				...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
			}),
			"sendChatAction",
		).catch((err: unknown) => {
			log.debug("record voice ping failed", { error: String(err) });
		});
		if (ctx.richMode()) ctx.refreshRichDrafts();
	}

	function onVoiceSynthesisStart(): () => void {
		ctx.clearTyping();
		sendRecording();
		const interval = every(ctx.typingIntervalMs, "telegram recording ping", sendRecording);
		ctx.addRecording(interval);
		return () => {
			interval.cancel();
			ctx.removeRecording(interval);
			if (ctx.recordingIntervals().size === 0 && !ctx.sinkDone() && ctx.authoritative()) {
				ctx.startTyping();
			}
		};
	}

	async function onDone(done: TurnDone, notice: string | null): Promise<void> {
		const voice = ctx.voice;
		if (voice === undefined) return;
		if (done.kind === "fenced") {
			await ctx.ackDropped();
			return;
		}
		if (done.kind === "error") {
			ctx.enqueue(async () => {
				if (!ctx.mayDeliver()) return;
				try {
					await withTimeout(
						api.sendMessage(conv.chatId, `⚠ ${done.message.slice(0, 200)}`, {
							...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
						}),
						"sendMessage",
					);
				} catch (error) {
					if (error instanceof TelegramTimeoutError) ctx.markUncertain(error, "sendMessage error");
					throw error;
				}
			});
			await ctx.settled();
			if (ctx.uncertain()) await ctx.notifyUncertain();
			return;
		}
		const content = speechContent(ctx.text());
		if (content.spoken === "" && content.supplemental === null && notice === null) {
			log.warn("completed turn rendered empty", {
				conversation: conv.id,
				chat: conv.chatId,
				...(conv.threadId !== null ? { thread: conv.threadId } : {}),
			});
			return;
		}
		try {
			let audio: Uint8Array[] = [];
			if (content.spoken !== "") {
				sendRecording();
				const synthesisPing = every(
					TYPING_INTERVAL_MS,
					"telegram synthesis recording ping",
					sendRecording,
				);
				try {
					audio = await voice.synthesize(content.spoken);
				} finally {
					synthesisPing.cancel();
				}
			}
			if (!ctx.authoritative()) {
				log.info("voice reply fenced before delivery", { conversation: conv.id });
				return;
			}
			const supplemental = content.supplemental;
			if (supplemental !== null) {
				let failure: { error: unknown } | undefined;
				ctx.enqueue(async () => {
					if (!ctx.mayDeliver()) return;
					try {
						await withTimeout(
							api.sendMessage(conv.chatId, supplemental, {
								...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
							}),
							"sendMessage",
						);
					} catch (error) {
						failure = { error };
						throw error;
					}
				});
				await ctx.settled();
				if (failure) throw failure.error;
			}
			for (const chunk of audio) await sendVoice(chunk);
			if (notice !== null) {
				ctx.enqueue(async () => {
					if (!ctx.mayDeliver()) return;
					await withTimeout(
						api.sendMessage(conv.chatId, notice, {
							...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
						}),
						"sendMessage",
					);
				});
			}
			await ctx.settled();
		} catch (err) {
			if (!ctx.authoritative()) return;
			if (err instanceof TelegramTimeoutError) {
				if (!ctx.uncertain()) ctx.markUncertain(err, err.label);
				await ctx.notifyUncertain();
				return;
			}
			log.warn("voice reply delivery failed — falling back to text", err, {
				conversation: conv.id,
			});
			const fallback = ctx.text() || "speech synthesis failed";
			let failed: unknown;
			for (const w of chunkWindows(fallback).map(renderWindow)) {
				const md = w.markdown;
				const formatted = w.html !== "" && w.html.length <= TG_MESSAGE_LIMIT;
				const out = formatted ? w.html : md === "" ? "…" : md;
				ctx.enqueue(async () => {
					if (!ctx.mayDeliver()) return;
					try {
						try {
							await withTimeout(
								api.sendMessage(conv.chatId, out, {
									...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
									...(formatted ? { parse_mode: "HTML" as const } : {}),
								}),
								"sendMessage",
							);
						} catch (err) {
							if (!formatted || !isParseEntitiesError(err)) throw err;
							await withTimeout(
								api.sendMessage(conv.chatId, md === "" ? "…" : md, {
									...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
								}),
								"sendMessage",
							);
						}
					} catch (error) {
						if (error instanceof TelegramTimeoutError)
							ctx.markUncertain(error, "sendMessage fallback");
						failed = error;
						throw error;
					}
				});
			}
			await ctx.settled();
			if (ctx.uncertain()) {
				await ctx.notifyUncertain();
				return;
			}
			if (failed) throw failed;
		}
	}

	return { sendVoice, sendRecording, onVoiceNote, onVoiceSynthesisStart, onDone };
}
