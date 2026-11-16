import { GrammyError, HttpError, type Api } from "grammy";
import type { Conversation, ConversationReads } from "../conversation-read.ts";
import { channelOf } from "../conversation-address.ts";
import type { TurnDone, TurnSink } from "../turn/sink.ts";
import { STATUS_TAIL_MARK } from "../agent/tts.ts";
import { log } from "../log.ts";
import { isNotModifiedError, isParseEntitiesError } from "./delivery-errors.ts";
import { makeFileDelivery } from "./delivery-files.ts";
import { makeRichDelivery } from "./delivery-rich.ts";
import { makeVoiceDelivery } from "./delivery-voice.ts";
import { escapeHtml, renderTelegramHtml, renderWindow, type WindowText } from "./tg-html.ts";
import {
	CHUNK_LIMIT,
	forcedNotice,
	isPrivateDmAddress,
	RICH_LIMIT,
	TG_MESSAGE_LIMIT,
	TYPING_INTERVAL_MS,
	fenceReopen,
	fenceStateAfter,
	type FenceState,
	windowEnd,
} from "./delivery-text.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import { rateCallbackData } from "./rate-button.ts";
import { SPEAK_CALLBACK } from "./speak-button.ts";

const EDIT_INTERVAL_MS = 1_000;
const DRAFT_TTL_MS = 20_000;
const MAX_DRAIN_ITERATIONS = 25;
const MAX_STAGNANT = 3;
const UNCERTAIN_NOTICE = "⚠ Delivery uncertain—check Telegram before retrying.";
const TRUNCATED_NOTICE =
	"⚠ Reply truncated — part of this reply didn't send. Ask me to repeat it if needed.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The parsed-text length of a rendered window — tags removed, entities
// decoded. Telegram's 4096 cap applies after entity parsing, so a code-
// heavy window full of <, >, & still counts by what the reader sees.
export function parsedTextLength(html: string): number {
	const text = html
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
	return text.length;
}

// What one chunk should display right now: HTML unless its parsed text
// overshoots Telegram's cap or it was already rejected — then the raw
// window.
function desiredText(c: Chunk, w: WindowText): { text: string; formatted: boolean } {
	if (!c.plain && parsedTextLength(w.html) <= TG_MESSAGE_LIMIT) {
		return { text: w.html === "" ? "…" : w.html, formatted: true };
	}
	return { text: w.markdown === "" ? "…" : w.markdown, formatted: false };
}

export interface DeliveryVoiceDeps {
	synthesize(text: string): Promise<Uint8Array[]>;
	voiceMode: boolean;
}

export interface DeliveryRatingDeps {
	lastReplyAnchor(conversationId: string): number | null;
}

export interface RichSinkOpts {
	enabled?: boolean;
	reasoning?: boolean;
}

interface Chunk {
	id: number;
	// The literal text last sent or successfully edited — HTML when
	// shownFormatted, raw markdown otherwise.
	shown: string;
	shownFormatted: boolean;
	// Telegram already rejected this chunk's HTML — it sends raw only.
	plain: boolean;
	// Body offset this chunk's window covered at last materialization —
	// the floor a recomputed window end may never cross back under.
	end: number;
	// The text of the edit already queued but not yet applied — dedupes
	// repeated flushes so an unchanged desired isn't edited twice.
	queued: string | null;
}

export type DeliveryApi = Api;

// One typing ping — intake's ack on the first buffered update of a lane
// (the delivery sink's interval owns liveness once the turn starts).
export function pingTypingOnce(api: Api, chatId: number, threadId: number | null): void {
	withTimeout(
		api.sendChatAction(chatId, "typing", {
			...(threadId !== null ? { message_thread_id: threadId } : {}),
		}),
		"sendChatAction",
	).catch((err: unknown) => {
		log.debug("typing ping failed", { error: String(err) });
	});
}

// Durable bubble→reply binding for the 🔊 button: each landed message
// id is recorded against the turn's reply event so the tap resolves
// the full text across restarts and chunk boundaries.
export interface DeliveryRecording {
	lastEntry: ConversationReads["lastEntry"];
	recordDelivery(conversationId: string, messageId: number, seq: number): void;
}

export interface DeliverySinkOptions {
	replyTo?: number;
	editIntervalMs?: number;
	voice?: DeliveryVoiceDeps;
	typingIntervalMs?: number;
	maxDrainIterations?: number;
	rating?: DeliveryRatingDeps;
	deliveries?: DeliveryRecording;
	rich?: RichSinkOpts;
	mediaGroupWindowMs?: number;
	draftTtlMs?: number;
}

export function makeDeliverySink(
	api: Api,
	conv: Conversation,
	{
		replyTo: replyToMessageId,
		editIntervalMs = EDIT_INTERVAL_MS,
		voice,
		typingIntervalMs = TYPING_INTERVAL_MS,
		maxDrainIterations = MAX_DRAIN_ITERATIONS,
		rating,
		deliveries,
		rich,
		mediaGroupWindowMs = 400,
		draftTtlMs = DRAFT_TTL_MS,
	}: DeliverySinkOptions = {},
): TurnSink {
	if (channelOf(conv.id) === "app") {
		throw new Error(`telegram delivery sink requested for app conversation ${conv.id}`);
	}
	let text = "";
	const toolStatus: string[] = [];
	const chunks: Chunk[] = [];
	let lastEdit = 0;
	let chain: Promise<void> = Promise.resolve();
	let replyTo = replyToMessageId;
	let authoritative = () => true;
	let cancelled = false;
	let uncertain = false;
	const mayDeliver = () => !cancelled && !uncertain && authoritative();

	function markUncertain(error: unknown, kind: string, chunk?: number): void {
		uncertain = true;
		log.warn("telegram delivery uncertain — not retrying", error, {
			conversation: conv.id,
			chat: conv.chatId,
			thread: conv.threadId,
			kind,
			...(chunk !== undefined ? { chunk } : {}),
			...(error instanceof TelegramTimeoutError ? { timeoutMs: error.ms } : {}),
		});
	}

	async function notifyTruncated(unsent: number): Promise<void> {
		if (cancelled || !authoritative()) return;
		try {
			const notice = await withTimeout(
				api.sendMessage(conv.chatId, TRUNCATED_NOTICE, {
					...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
				}),
				"sendMessage",
			);
			log.info("delivery truncation notice sent", {
				conversation: conv.id,
				chat: conv.chatId,
				thread: conv.threadId,
				message: notice.message_id,
				unsent,
			});
		} catch (error) {
			log.warn("delivery truncation notice failed — not retrying", error, {
				conversation: conv.id,
				chat: conv.chatId,
				thread: conv.threadId,
				unsent,
			});
		}
	}

	async function notifyUncertain(): Promise<void> {
		if (cancelled || !authoritative()) {
			log.info("delivery uncertainty notice fenced", {
				conversation: conv.id,
				chat: conv.chatId,
				thread: conv.threadId,
			});
			return;
		}
		try {
			const notice = await withTimeout(
				api.sendMessage(conv.chatId, UNCERTAIN_NOTICE, {
					...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
				}),
				"sendMessage",
			);
			log.info("delivery uncertainty notice sent", {
				conversation: conv.id,
				chat: conv.chatId,
				thread: conv.threadId,
				message: notice.message_id,
			});
		} catch (error) {
			log.warn("delivery uncertainty notice failed — not retrying", error, {
				conversation: conv.id,
				chat: conv.chatId,
				thread: conv.threadId,
			});
		}
	}
	let typing = setInterval(sendTyping, typingIntervalMs);
	const recordings = new Set<ReturnType<typeof setInterval>>();
	let sinkDone = false;

	let richMode = rich?.enabled === true && isPrivateDmAddress(conv.id) && !voice?.voiceMode;

	function enqueue(fn: () => Promise<void>): void {
		chain = chain.then(() =>
			fn().catch((err: unknown) => {
				log.warn("telegram delivery failed", err, { conversation: conv.id });
			}),
		);
	}

	const richDelivery = makeRichDelivery(
		{
			api,
			conv,
			enqueue,
			settled: () => chain,
			mayDeliver,
			richMode: () => richMode,
			setRichMode: (value) => {
				richMode = value;
			},
			rendered,
			replyTo: () => replyTo,
			notifyUncertain,
			markUncertain,
			buildKeyboard,
			recordRichDelivery(messageId) {
				if (!voice || deliveries === undefined) return;
				const seq = deliveries.lastEntry(conv.id, "assistant")?.seq ?? null;
				if (seq !== null) deliveries.recordDelivery(conv.id, messageId, seq);
			},
		},
		{ ...(rich?.reasoning !== undefined ? { reasoning: rich.reasoning } : {}), draftTtlMs },
	);

	function sendTyping(): void {
		if (!mayDeliver()) return;
		if (recordings.size === 0) pingTyping();
		if (richMode) richDelivery.refreshRichDrafts();
	}
	sendTyping();
	function pingTyping(): void {
		pingTypingOnce(api, conv.chatId, conv.threadId);
	}
	function repingTyping(): void {
		if (sinkDone || recordings.size > 0 || !mayDeliver()) return;
		pingTyping();
	}
	// Files/albums (photo batches, documents) live in delivery-files.ts,
	// fed live views of this sink's mutable state — never snapshots.
	const { sendFile, flushPhotoBatch } = makeFileDelivery(
		{
			api,
			conv,
			enqueue,
			settled: () => chain,
			mayDeliver,
			uncertain: () => uncertain,
			markUncertain,
			noteLanded: repingTyping,
			authoritative: () => authoritative(),
		},
		{ mediaGroupWindowMs },
	);

	const voiceDelivery = makeVoiceDelivery({
		api,
		conv,
		...(voice !== undefined ? { voice } : {}),
		text: () => text,
		notifyUncertain,
		ackDropped,
		typingIntervalMs,
		enqueue,
		settled: () => chain,
		mayDeliver,
		uncertain: () => uncertain,
		markUncertain,
		authoritative: () => authoritative(),
		repingTyping,
		clearTyping: () => clearInterval(typing),
		startTyping: () => {
			typing = setInterval(sendTyping, typingIntervalMs);
		},
		sinkDone: () => sinkDone,
		recordingIntervals: () => recordings,
		addRecording: (interval) => recordings.add(interval),
		removeRecording: (interval) => recordings.delete(interval),
		richMode: () => richMode,
		refreshRichDrafts: richDelivery.refreshRichDrafts,
	});

	function rendered(): string {
		const status =
			toolStatus.length > 0 ? `${STATUS_TAIL_MARK}${toolStatus.slice(-5).join("\n")}` : "";
		return text + status;
	}

	function flush(): void {
		if (!mayDeliver()) return;
		const body = rendered();
		if (richMode) {
			if (body.length > RICH_LIMIT) {
				log.warn("rich reply over cap — plain chunks from here", {
					conversation: conv.id,
					chars: body.length,
				});
				richMode = false;
			} else {
				richDelivery.pushDrafts(body);
				lastEdit = Date.now();
				return;
			}
		}
		materialize(body, false);
		lastEdit = Date.now();
	}

	// The text each window should currently show — incremental: a
	// chunk's window end is clamped to at least the body offset it
	// already covered, so a seam that surfaces only once the body
	// crosses the cap (a paragraph break behind shown text) never
	// edits already-shown text away; the pending tail simply becomes
	// the next window. Each window renders to HTML independently.
	function windowTexts(body: string): (WindowText & { end: number })[] {
		const wins: (WindowText & { end: number })[] = [];
		// Everything at/after `text` is the tool-status tail — raw
		// command text, not model markdown. It is HTML-escaped, never
		// markdown-rendered, or a glob like "*.ts" becomes italics.
		const statusStart = text.length;
		let start = 0;
		let fence: FenceState | null = null;
		while (start < body.length) {
			const c = chunks[wins.length];
			let end = windowEnd(body, start);
			if (c !== undefined && end < c.end) end = c.end;
			const raw = body.slice(start, end);
			const reopen = fence !== null ? fenceReopen(fence) : "";
			// Fence state tracks model text only — the status tail can
			// hold anything (a command arg starting with ``` must not
			// open or close a fence).
			fence = fenceStateAfter(raw.slice(0, Math.max(0, statusStart - start)), fence);
			const close = fence !== null ? `\n${fence.marker}` : "";
			const markdown = `${reopen}${raw}${close}`;
			let html: string;
			if (statusStart >= end) {
				html = renderWindow(markdown).html;
			} else if (statusStart <= start) {
				html = escapeHtml(raw);
			} else {
				const k = statusStart - start;
				// The head render closes any open fence in HTML itself;
				// the status is escaped raw, and no marker lands after it.
				html =
					renderTelegramHtml(`${reopen}${raw.slice(0, k)}`) + escapeHtml(raw.slice(k));
			}
			wins.push({ markdown, html, end });
			start = end;
		}
		return wins;
	}

	// Push the windows to Telegram: send/edit whatever doesn't match.
	// `force` rides over a cancelled or superseded turn — never over an
	// uncertain send — so the superseded stamp can land the pending
	// tail before it marks. Without it one new send goes out per call.
	function materialize(body: string, force: boolean): void {
		const wins = windowTexts(body);
		while (chunks.length < wins.length)
			chunks.push({
				id: -1,
				shown: "",
				shownFormatted: false,
				plain: false,
				end: 0,
				queued: null,
			});
		for (let idx = 0; idx < chunks.length; idx++) {
			const c = chunks[idx]!;
			if (c.id === -2) {
				if (!force) break;
				continue;
			}
			const w = wins[idx];
			if (w !== undefined) c.end = w.end;
			const wm = w ?? { markdown: "", html: "", end: 0 };
			const d = desiredText(c, wm);
			if (c.id === -1) {
				if (wm.markdown === "") continue;
				c.id = -2;
				c.shown = d.text;
				c.shownFormatted = d.formatted;
				const fallback = wm.markdown === "" ? "…" : wm.markdown;
				const send = (text: string, formatted: boolean) =>
					withTimeout(
						api.sendMessage(conv.chatId, text, {
							...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
							...(formatted ? { parse_mode: "HTML" as const } : {}),
							...(idx === 0 && replyTo !== undefined
								? { reply_parameters: { message_id: replyTo } }
								: {}),
						}),
						"sendMessage",
					);
				enqueue(async () => {
					if (uncertain || (!force && !mayDeliver())) {
						c.id = -1;
						return;
					}
					try {
						let sent;
						try {
							sent = await send(d.text, d.formatted);
						} catch (err) {
							// A 400 entity rejection is definite — nothing landed,
							// so the chunk retries once raw and stays plain.
							if (!d.formatted || !isParseEntitiesError(err)) throw err;
							c.plain = true;
							sent = await send(fallback, false);
							c.shown = fallback;
							c.shownFormatted = false;
						}
						c.id = sent.message_id;
						log.debug("delivered", {
							conversation: conv.id,
							message: sent.message_id,
							...(conv.threadId !== null ? { thread: conv.threadId } : {}),
						});
						repingTyping();
					} catch (err) {
						const transportCause =
							err instanceof HttpError ? (err.error as { code?: unknown } | null) : null;
						const transportError =
							transportCause !== null &&
							typeof transportCause === "object" &&
							typeof transportCause.code === "string";
						if (
							err instanceof TelegramTimeoutError ||
							(!(err instanceof GrammyError) && transportError)
						) {
							markUncertain(err, "sendMessage", idx);
						} else {
							replyTo = undefined;
							c.id = -1;
						}
						throw err;
					}
				});
				if (!force) break;
				continue;
			}
			if (c.shown !== d.text && c.queued !== d.text) {
				const mid = c.id;
				const out = d.text;
				const formatted = d.formatted;
				const fallback = wm.markdown === "" ? "…" : wm.markdown;
				c.queued = out;
				const clearQueued = () => {
					if (c.queued === out) c.queued = null;
				};
				enqueue(async () => {
					if (uncertain || (!force && !mayDeliver())) {
						clearQueued();
						return;
					}
					try {
						try {
							await withTimeout(
								api.editMessageText(
									conv.chatId,
									mid,
									out,
									formatted ? { parse_mode: "HTML" as const } : {},
								),
								"editMessageText",
							);
						} catch (err) {
							// Same definite-400 fallback as the send path.
							if (formatted && isParseEntitiesError(err)) {
								c.plain = true;
								await withTimeout(
									api.editMessageText(conv.chatId, mid, fallback),
									"editMessageText",
								);
								c.shown = fallback;
								c.shownFormatted = false;
								clearQueued();
								return;
							}
							throw err;
						}
					} catch (err) {
						clearQueued();
						if (isNotModifiedError(err)) {
							log.debug("edit no-op — message already current", {
								conversation: conv.id,
								message: mid,
							});
							c.shown = out;
							c.shownFormatted = formatted;
							return;
						}
						throw err;
					}
					c.shown = out;
					c.shownFormatted = formatted;
					clearQueued();
				});
			}
		}
	}

	let droppedAcked = false;
	// A fenced turn whose sink never landed a bubble would otherwise
	// vanish silently — one ack, threaded to the dropped message, tells
	// the sender their input survived the stop and stays in history.
	async function ackDropped(): Promise<void> {
		if (
			droppedAcked ||
			!cancelled ||
			replyTo === undefined ||
			chunks.some((c) => c.id > 0)
		)
			return;
		droppedAcked = true;
		try {
			const sent = await withTimeout(
				api.sendMessage(
					conv.chatId,
					"⏹ Stopped before I answered — your message is kept in history.",
					{
						...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
						reply_parameters: { message_id: replyTo },
					},
				),
				"sendMessage",
			);
			log.info("sent drop acknowledgement", {
				conversation: conv.id,
				message: sent.message_id,
				reply: replyTo,
			});
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				markUncertain(err, "sendMessage drop-ack");
				await notifyUncertain();
				return;
			}
			log.warn("drop acknowledgement failed", err, { conversation: conv.id });
		}
	}

	// Every landed chunk binds to the turn's reply event, so a 🔊 tap on
	// any bubble of a split reply resolves the whole text durably.
	function recordDeliveries(): void {
		if (deliveries === undefined) return;
		const seq = deliveries.lastEntry(conv.id, "assistant")?.seq ?? null;
		if (seq === null) {
			log.warn("completed reply has no assistant event — deliveries unrecorded", {
				conversation: conv.id,
			});
			return;
		}
		for (const c of chunks) {
			if (c.id > 0) deliveries.recordDelivery(conv.id, c.id, seq);
		}
	}

	async function stampSuperseded(): Promise<void> {
		await chain;
		if (richMode) {
			// A rich reply has no editable bubble — the draft is the only
			// visible surface, so the stamp goes on the draft itself,
			// carrying whatever deltas were still unflushed. No draft was
			// ever pushed → nothing visible → nothing to stamp — but a
			// fenced drop still gets its ack.
			if (!(await richDelivery.stampSuperseded())) await ackDropped();
			return;
		}
		// Nothing landed → nothing shown to preserve: acknowledge the
		// fenced drop, no stamp, no tail.
		if (!chunks.some((c) => c.id > 0)) {
			await ackDropped();
			return;
		}
		// Pending deltas still land — shown text is never edited back.
		// The tail goes out as its own window(s); the stamp marks the
		// last bubble.
		materialize(rendered(), true);
		await chain;
		const idx = chunks.findLastIndex((c) => c.id > 0);
		if (idx === -1) return;
		const c = chunks[idx]!;
		const mid = c.id;
		// The stamp marks the last bubble as it stands — shown text is
		// never edited back. A mark that pushes the parsed text past
		// Telegram's cap falls back to the raw window.
		let marked = `${c.shown}${STATUS_TAIL_MARK}⏹ superseded`;
		let formatted = c.shownFormatted;
		if (formatted && parsedTextLength(marked) > TG_MESSAGE_LIMIT) {
			const wm = windowTexts(rendered())[idx] ?? { markdown: c.shown, html: "" };
			marked = `${wm.markdown}${STATUS_TAIL_MARK}⏹ superseded`;
			formatted = false;
		}
		enqueue(async () => {
			try {
				await withTimeout(
					api.editMessageText(
						conv.chatId,
						mid,
						marked,
						formatted ? { parse_mode: "HTML" as const } : {},
					),
					"editMessageText",
				);
				log.debug("delivery superseded marker", { conversation: conv.id, message: mid });
			} catch (err) {
				if (isNotModifiedError(err)) return;
				throw err;
			}
		});
		await chain;
	}

	function maybeFlush(): void {
		if (Date.now() - lastEdit >= editIntervalMs) flush();
	}

	function pendingCount(): number {
		const wins = windowTexts(rendered());
		let n = 0;
		for (let idx = 0; idx < chunks.length; idx++) {
			const c = chunks[idx]!;
			const w = wins[idx] ?? { markdown: "", html: "", end: 0 };
			if (c.id === -1 ? w.markdown !== "" : c.shown !== desiredText(c, w).text) n++;
		}
		return n;
	}

	function buildKeyboard(): Array<Array<{ text: string; callback_data: string }>> | null {
		if (rating === undefined && voice === undefined) return null;
		const anchor = rating?.lastReplyAnchor(conv.id) ?? null;
		const row: Array<{ text: string; callback_data: string }> = [];
		if (rating !== undefined) {
			row.push(
				{ text: "👍", callback_data: rateCallbackData("up", conv.id, anchor) },
				{ text: "👎", callback_data: rateCallbackData("down", conv.id, anchor) },
			);
		}
		if (voice !== undefined) row.push({ text: "🔊", callback_data: SPEAK_CALLBACK });
		return [row];
	}

	return {
		setAuthorityCheck(check) {
			authoritative = check;
		},
		onTextDelta(delta) {
			text += delta;
			if (!voice?.voiceMode) maybeFlush();
		},
		onReasoningDelta(delta) {
			richDelivery.onReasoningDelta(delta);
			if (!voice?.voiceMode) maybeFlush();
		},
		onToolCall(toolName, input) {
			const hint =
				toolName === "bash"
					? String((input as { command?: string }).command ?? "").slice(0, 60)
					: String((input as { path?: string }).path ?? "").slice(0, 60);
			toolStatus.push(`⚙ ${toolName}${hint ? ` ${hint}` : ""}`);
			if (!voice?.voiceMode) flush();
		},
		async onVoiceNote(audio) {
			await voiceDelivery.onVoiceNote(audio);
		},
		async onFile(file) {
			await sendFile(file);
		},
		onVoiceSynthesisStart() {
			return voiceDelivery.onVoiceSynthesisStart();
		},
		async onDone(done: TurnDone) {
			if (done.kind === "fenced") cancelled = true;
			const notice = forcedNotice(done);
			if (notice !== null) text += `${STATUS_TAIL_MARK}${notice}`;
			clearInterval(typing);
			for (const interval of recordings) clearInterval(interval);
			recordings.clear();
			sinkDone = true;
			if (uncertain) {
				await chain;
				if (cancelled || !authoritative()) await stampSuperseded();
				else await notifyUncertain();
				return;
			}
			if (voice?.voiceMode) {
				await voiceDelivery.onDone(done, notice);
				return;
			}
			if (!mayDeliver()) {
				await stampSuperseded();
				return;
			}
			if (done.kind === "error") {
				toolStatus.push(`⚠ ${done.message.slice(0, 200)}`);
			}
			if (richMode) {
				await chain;
				if (uncertain) {
					await notifyUncertain();
					return;
				}
				if (!mayDeliver()) {
					await stampSuperseded();
					return;
				}
				if (richMode && (await richDelivery.finalize(done))) return;
			}
			let prevPending = Number.POSITIVE_INFINITY;
			let stagnant = 0;
			let gaveUp = false;
			for (let i = 0; i < maxDrainIterations; i++) {
				flush();
				await chain;
				if (uncertain) {
					await notifyUncertain();
					return;
				}
				if (!mayDeliver()) {
					await stampSuperseded();
					return;
				}
				const pending = pendingCount();
				if (pending === 0) {
					flush();
					await chain;
					if (uncertain) {
						await notifyUncertain();
						return;
					}
					if (!mayDeliver()) {
						await stampSuperseded();
						return;
					}
					break;
				}
				stagnant = pending >= prevPending ? stagnant + 1 : 0;
				prevPending = pending;
				if (stagnant >= MAX_STAGNANT) {
					log.warn("delivery gave up on unsent chunks", {
						conversation: conv.id,
						unsent: pending,
					});
					gaveUp = true;
					break;
				}
				await sleep(300 * stagnant);
			}
			flushPhotoBatch();
			await chain;
			if (uncertain) {
				await notifyUncertain();
				return;
			}
			if (!mayDeliver()) {
				await stampSuperseded();
				return;
			}
			const unsent = pendingCount();
			if (unsent > 0 && !gaveUp) {
				log.warn("delivery gave up on unsent chunks", {
					conversation: conv.id,
					unsent,
				});
			}
			if (unsent > 0) await notifyTruncated(unsent);
			if (done.kind === "completed" && voice) recordDeliveries();
			if (unsent === 0) {
				const landed = chunks.filter((c) => c.id > 0).length;
				if (landed > 0) {
					log.info("delivered plain", {
						conversation: conv.id,
						chat: conv.chatId,
						...(conv.threadId !== null ? { thread: conv.threadId } : {}),
						messages: landed,
						chars: rendered().length,
					});
				}
			}
			if (done.kind === "completed" && pendingCount() === 0) {
				const last = [...chunks].reverse().find((c) => c.id > 0);
				if (last) {
					const mid = last.id;
					enqueue(async () => {
						if (!mayDeliver()) return;
						await withTimeout(
							api.setMessageReaction(conv.chatId, mid, [{ type: "emoji", emoji: "🫡" }]),
							"setMessageReaction",
						);
					});
					const keyboard = buildKeyboard();
					if (keyboard !== null) {
						enqueue(async () => {
							if (!mayDeliver()) return;
							try {
								await withTimeout(
									api.editMessageReplyMarkup(conv.chatId, mid, {
										reply_markup: { inline_keyboard: keyboard },
									}),
									"editMessageReplyMarkup",
								);
							} catch (err) {
								if (isNotModifiedError(err)) return;
								throw err;
							}
						});
					}
					await chain;
					if (!mayDeliver()) await stampSuperseded();
				} else {
					log.warn("completed turn rendered empty", {
						conversation: conv.id,
						chat: conv.chatId,
						...(conv.threadId !== null ? { thread: conv.threadId } : {}),
					});
				}
			}
		},
	};
}
