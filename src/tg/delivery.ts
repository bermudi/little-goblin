import { GrammyError, HttpError, InputFile, type Api } from "grammy";
import { MAX_SEND_BYTES } from "../agent/tools/send.ts";
import { stat } from "node:fs/promises";
import { channelOf, type Conversation } from "../conversation.ts";
import type { TurnDone, TurnSink } from "../runtime.ts";
import { sniffImage } from "../agent/tools/read.ts";
import { DeliveryUncertainError, type OutgoingFile } from "../agent/tools/send.ts";
import { speechContent, STATUS_TAIL_MARK } from "../agent/tts.ts";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import { rateCallbackData } from "./rate-button.ts";

const EDIT_INTERVAL_MS = 1_000;
const TYPING_INTERVAL_MS = 4_000;
const DRAFT_TTL_MS = 20_000;
const CHUNK_LIMIT = 3800;
const RICH_LIMIT = 32_000;
const REASONING_BLOCK_OVERHEAD =
	"<details><summary>Thinking</summary>\n<pre></pre>\n</details>\n\n".length + 1;
// Draft ids must be non-zero; updates under one id animate.
let nextDraftId = 1;

const SALUTE_EFFECT_ID = "4913930782671635058";
let messageEffectsUsable = true;

export function resetMessageEffectsGateForTests(): void {
	messageEffectsUsable = true;
}

function isPremiumGateError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some((h) => typeof h === "string" && h.includes("PREMIUM_ACCOUNT_REQUIRED"));
}
const MAX_DRAIN_ITERATIONS = 25;
const MAX_STAGNANT = 3;
const RECENT_REPLY_LIMIT = 256;
const UNCERTAIN_NOTICE = "⚠ Delivery uncertain—check Telegram before retrying.";
export const SPEAK_CALLBACK = "speak_reply";

const recentReplies = new Map<string, string>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isNotModifiedError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some(
		(h) => typeof h === "string" && h.toLowerCase().includes("message is not modified"),
	);
}

export function isMessageGoneError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some(
		(h) =>
			typeof h === "string" &&
			(h.includes("message to edit not found") || h.includes("message not found")),
	);
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

function replyKey(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

function forcedNotice(done: TurnDone): string | null {
	if (done.kind !== "completed" || done.forced === undefined) return null;
	switch (done.forced) {
		case "repeat":
			return "⚠ loop detector — answer forced";
		case "watchdog":
			return "⚠ loop watchdog — answer forced";
		case "context":
			return "⚠ context nearly full — answer forced";
	}
}

export function rememberReply(chatId: number, messageId: number, text: string): void {
	recentReplies.set(replyKey(chatId, messageId), text);
	while (recentReplies.size > RECENT_REPLY_LIMIT) {
		const oldest = recentReplies.keys().next().value;
		if (oldest === undefined) break;
		recentReplies.delete(oldest);
	}
}

export function recentReplyText(chatId: number, messageId: number): string | null {
	return recentReplies.get(replyKey(chatId, messageId)) ?? null;
}

interface Chunk {
	id: number;
	shown: string;
}

// A split surrogate pair is a lone surrogate Telegram may reject or mangle.
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function windowEnd(body: string, start: number): number {
	const end = start + CHUNK_LIMIT;
	if (
		end < body.length &&
		isHighSurrogate(body.charCodeAt(end - 1)) &&
		isLowSurrogate(body.charCodeAt(end))
	) {
		return end - 1;
	}
	return end;
}

export type DeliveryApi = Api;

export interface DeliverySinkOptions {
	replyTo?: number;
	editIntervalMs?: number;
	voice?: DeliveryVoiceDeps;
	typingIntervalMs?: number;
	maxDrainIterations?: number;
	rating?: DeliveryRatingDeps;
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

	const richOpts = rich;
	const answerDraftId = nextDraftId++;
	const reasonDraftId = nextDraftId++;
	let richMode = richOpts?.enabled === true && conv.id.startsWith("dm:") && !voice?.voiceMode;
	const reasoningOn = richOpts?.reasoning === true && conv.persona !== "guest";
	let reasoningText = "";
	let reasoningPushed = 0;
	let reasoningSentAt = 0;
	let lastDraftBody = "";
	let lastDraftSentAt = 0;

	function enqueue(fn: () => Promise<void>): void {
		chain = chain.then(() =>
			fn().catch((err: unknown) => {
				log.warn("telegram delivery failed", err, { conversation: conv.id });
			}),
		);
	}

	function sendTyping(): void {
		if (!mayDeliver()) return;
		if (recordings.size === 0) pingTyping();
		if (richMode) refreshRichDrafts();
	}
	sendTyping();
	function pingTyping(): void {
		withTimeout(
			api.sendChatAction(conv.chatId, "typing", {
				...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
			}),
			"sendChatAction",
		).catch((err: unknown) => {
			log.debug("typing ping failed", { error: String(err) });
		});
	}
	function repingTyping(): void {
		if (sinkDone || recordings.size > 0 || !mayDeliver()) return;
		pingTyping();
	}
	function refreshRichDrafts(): void {
		const body = rendered();
		const stale =
			body !== lastDraftBody ||
			Date.now() - lastDraftSentAt > draftTtlMs ||
			reasoningText.length !== reasoningPushed ||
			(reasoningText !== "" && Date.now() - reasoningSentAt > draftTtlMs);
		if (stale) pushDrafts(body);
	}
	function sendRecording(): void {
		if (!authoritative()) return;
		withTimeout(
			api.sendChatAction(conv.chatId, "record_voice", {
				...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
			}),
			"sendChatAction",
		).catch((err: unknown) => {
			log.debug("record voice ping failed", { error: String(err) });
		});
		if (richMode) refreshRichDrafts();
	}

	async function sendVoice(audio: Uint8Array): Promise<void> {
		if (uncertain) {
			throw new Error(
				"Telegram delivery uncertain — voice not sent again; check Telegram before retrying",
			);
		}
		if (!mayDeliver()) return;
		let failure: { error: unknown } | undefined;
		enqueue(async () => {
			if (!mayDeliver()) return;
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
				if (error instanceof TelegramTimeoutError) markUncertain(error, "sendVoice");
				failure = { error };
				throw error;
			}
		});
		await chain;
		if (failure) throw failure.error;
		repingTyping();
		if (uncertain) {
			throw new Error(
				"Telegram delivery uncertain — voice not sent again; check Telegram before retrying",
			);
		}
	}

	interface QueuedPhoto {
		file: OutgoingFile;
		bytes: number;
		error?: unknown;
	}
	let photoQueue: QueuedPhoto[] = [];
	let photoBatchWait: Promise<void> | null = null;
	let photoBatchResolve: (() => void) | null = null;
	let photoKick: ReturnType<typeof setTimeout> | null = null;

	function flushPhotoBatch(): void {
		if (photoBatchResolve === null) return;
		if (photoKick !== null) {
			clearTimeout(photoKick);
			photoKick = null;
		}
		const batch = photoQueue;
		photoQueue = [];
		const resolve = photoBatchResolve;
		photoBatchResolve = null;
		photoBatchWait = null;
		enqueue(async () => {
			try {
				await sendPhotoBatch(batch);
			} finally {
				resolve();
			}
		});
	}

	function joinPhotoBatch(q: QueuedPhoto): Promise<void> {
		photoQueue.push(q);
		if (photoBatchWait === null) {
			photoBatchWait = new Promise<void>((resolve) => {
				photoBatchResolve = resolve;
			});
			photoKick = setTimeout(flushPhotoBatch, mediaGroupWindowMs);
		}
		return photoBatchWait;
	}

	async function sendPhotoSolo(
		q: QueuedPhoto,
		thread: { message_thread_id?: number },
	): Promise<void> {
		if (q.bytes > MAX_SEND_BYTES)
			throw new Error(`file too large: ${q.file.path} (${q.bytes} bytes, max ${MAX_SEND_BYTES})`);
		if (!mayDeliver()) return;
		try {
			const sent = await withTimeout(
				api.sendPhoto(conv.chatId, new InputFile(q.file.path, q.file.filename), {
					...thread,
					...(q.file.caption !== undefined ? { caption: q.file.caption } : {}),
				}),
				"sendPhoto",
			);
			log.debug("file delivered", {
				conversation: conv.id,
				message: sent.message_id,
				path: q.file.path,
				bytes: q.bytes,
				kind: "photo",
				...(conv.threadId !== null ? { thread: conv.threadId } : {}),
			});
			repingTyping();
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				markUncertain(err, "sendPhoto");
				throw new DeliveryUncertainError(err);
			}
			throw err;
		}
	}

	async function sendPhotoBatch(batch: QueuedPhoto[]): Promise<void> {
		if (uncertain) {
			for (const q of batch) {
				q.error = new Error("not sent — delivery stopped after an uncertain timeout");
			}
			return;
		}
		if (!mayDeliver()) return;
		const thread = conv.threadId !== null ? { message_thread_id: conv.threadId } : {};
		const sendable: QueuedPhoto[] = [];
		for (const q of batch) {
			try {
				q.bytes = (await stat(q.file.path)).size;
				sendable.push(q);
			} catch {
				q.error = new Error(`file unreadable: ${q.file.path}`);
			}
		}
		const delivered = new Set<QueuedPhoto>();
		const markUnsent = (): void => {
			if (!uncertain) return;
			for (const q of sendable) {
				if (!delivered.has(q) && q.error === undefined) {
					q.error = new Error("not sent — delivery stopped after an uncertain timeout");
				}
			}
		};
		let fallback: QueuedPhoto[] | null = null;
		for (let at = 0; at < sendable.length; at += 10) {
			if (!mayDeliver()) {
				markUnsent();
				return;
			}
			const group = sendable.slice(at, at + 10);
			if (group.length === 1) {
				try {
					await sendPhotoSolo(group[0]!, thread);
					delivered.add(group[0]!);
				} catch (err) {
					if (err instanceof DeliveryUncertainError) {
						for (const q of sendable) if (!delivered.has(q)) q.error = err;
						return;
					}
					group[0]!.error = err;
					delivered.add(group[0]!);
				}
				continue;
			}
			const media = group.map((q) => ({
				type: "photo" as const,
				media: new InputFile(q.file.path, q.file.filename),
				...(q.file.caption !== undefined ? { caption: q.file.caption } : {}),
			}));
			try {
				const sent = await withTimeout(
					api.sendMediaGroup(conv.chatId, media, thread),
					"sendMediaGroup",
				);
				for (const q of group) delivered.add(q);
				log.debug("media group delivered", {
					conversation: conv.id,
					messages: sent.length,
					files: group.length,
					...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				});
				repingTyping();
			} catch (err) {
				if (err instanceof TelegramTimeoutError) {
					markUncertain(err, "sendMediaGroup");
					const wrapped = new DeliveryUncertainError(err);
					for (const q of sendable) if (!delivered.has(q)) q.error = wrapped;
					return;
				}
				log.warn("media group failed — falling back to solo sends", err, {
					conversation: conv.id,
					chat: conv.chatId,
					files: sendable.length - delivered.size,
				});
				fallback = sendable.filter((q) => !delivered.has(q));
				break;
			}
		}
		if (fallback === null) return;
		for (const q of fallback) {
			if (!mayDeliver()) {
				markUnsent();
				return;
			}
			try {
				await sendPhotoSolo(q, thread);
			} catch (err) {
				q.error = err;
				if (err instanceof DeliveryUncertainError) {
					for (const rest of fallback) if (rest.error === undefined) rest.error = err;
					return;
				}
			}
		}
	}

	async function sendFile(file: OutgoingFile): Promise<void> {
		if (!authoritative()) return;
		const sniff = sniffImage(file.path);
		const photo = !file.asFile && sniff !== null && sniff.mediaType !== "image/gif";
		if (photo) {
			const q: QueuedPhoto = { file, bytes: 0 };
			const wait = joinPhotoBatch(q);
			await wait;
			if (q.error !== undefined) throw q.error;
			return;
		}
		const st = await stat(file.path).catch((err: unknown) => {
			throw new Error(`file unreadable: ${file.path} (${String(err)})`);
		});
		return sendDocumentSolo(file, st.size);
	}

	async function sendDocumentSolo(file: OutgoingFile, bytes: number): Promise<void> {
		if (bytes > MAX_SEND_BYTES)
			throw new Error(`file too large: ${file.path} (${bytes} bytes, max ${MAX_SEND_BYTES})`);
		let failure: { err: unknown } | undefined;
		enqueue(async () => {
			if (uncertain) {
				failure = {
					err: new Error("not sent — delivery stopped after an uncertain timeout"),
				};
				return;
			}
			if (!mayDeliver()) return;
			const extra = {
				...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
				...(file.caption !== undefined ? { caption: file.caption } : {}),
			};
			try {
				const sent = await withTimeout(
					api.sendDocument(conv.chatId, new InputFile(file.path, file.filename), extra),
					"sendDocument",
				);
				log.debug("file delivered", {
					conversation: conv.id,
					message: sent.message_id,
					path: file.path,
					bytes,
					kind: "document",
					...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				});
				repingTyping();
			} catch (err) {
				if (err instanceof TelegramTimeoutError) {
					markUncertain(err, "sendDocument");
					err = new DeliveryUncertainError(err);
				}
				failure = { err };
				throw err;
			}
		});
		await chain;
		if (failure !== undefined) throw failure.err;
	}

	function rendered(): string {
		const status =
			toolStatus.length > 0 ? `${STATUS_TAIL_MARK}${toolStatus.slice(-5).join("\n")}` : "";
		return text + status;
	}

	function richFailure(err: unknown, method: string): never {
		log.warn("rich delivery failed — falling back to plain", err, {
			conversation: conv.id,
			chat: conv.chatId,
			method,
		});
		richMode = false;
		throw err;
	}

	function pushDrafts(body: string): void {
		if (
			reasoningOn &&
			reasoningText !== "" &&
			(reasoningText.length !== reasoningPushed || Date.now() - reasoningSentAt > 20_000)
		) {
			const snap = reasoningText;
			reasoningPushed = snap.length;
			reasoningSentAt = Date.now();
			enqueue(async () => {
				if (!mayDeliver() || !richMode) return;
				const tail = snap.length > 4000 ? `…${snap.slice(-4000)}` : snap;
				try {
					await withTimeout(
						api.sendRichMessageDraft(conv.chatId, reasonDraftId, {
							blocks: [{ type: "thinking", text: tail }],
						}),
						"sendRichMessageDraft",
					);
				} catch (err) {
					if (isNotModifiedError(err)) return;
					richFailure(err, "sendRichMessageDraft");
				}
			});
		}
		lastDraftBody = body;
		lastDraftSentAt = Date.now();
		const method = body === "" ? "sendMessageDraft" : "sendRichMessageDraft";
		enqueue(async () => {
			if (!mayDeliver() || !richMode) return;
			try {
				if (body === "") {
					await withTimeout(api.sendMessageDraft(conv.chatId, answerDraftId, ""), method);
				} else {
					await withTimeout(
						api.sendRichMessageDraft(conv.chatId, answerDraftId, { markdown: body }),
						method,
					);
				}
			} catch (err) {
				if (isNotModifiedError(err)) return;
				richFailure(err, method);
			}
		});
	}

	function reasoningBlock(budget: number): string {
		if (!reasoningOn) return "";
		const trimmed = reasoningText.trim();
		if (trimmed === "") return "";
		const escaped = trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		const room = Math.min(8_000, budget - REASONING_BLOCK_OVERHEAD);
		if (room <= 0) return "";
		if (escaped.length <= room) {
			return `<details><summary>Thinking</summary>\n<pre>${escaped}</pre>\n</details>\n\n`;
		}
		let tail = escaped.slice(-room);
		const semi = tail.indexOf(";");
		const amp = tail.indexOf("&");
		if (semi !== -1 && (amp === -1 || semi < amp)) tail = tail.slice(semi + 1);
		return `<details><summary>Thinking</summary>\n<pre>…${tail}</pre>\n</details>\n\n`;
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
				pushDrafts(body);
				lastEdit = Date.now();
				return;
			}
		}
		const needed = Math.ceil(body.length / CHUNK_LIMIT);
		while (chunks.length < needed) chunks.push({ id: -1, shown: "" });
		let start = 0;
		for (let idx = 0; idx < chunks.length; idx++) {
			const c = chunks[idx]!;
			if (c.id === -2) break;
			const isLast = idx === chunks.length - 1;
			const end = isLast ? body.length : windowEnd(body, start);
			const desired = body.slice(start, end);
			const out = desired === "" ? "…" : desired;
			if (c.id === -1) {
				if (desired === "") break;
				c.id = -2;
				c.shown = out;
				enqueue(async () => {
					if (!mayDeliver()) {
						c.id = -1;
						return;
					}
					try {
						const sent = await withTimeout(
							api.sendMessage(conv.chatId, out, {
								...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
								...(idx === 0 && replyTo !== undefined
									? { reply_parameters: { message_id: replyTo } }
									: {}),
							}),
							"sendMessage",
						);
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
				break;
			}
			if (c.shown !== out) {
				const mid = c.id;
				enqueue(async () => {
					if (!mayDeliver()) return;
					try {
						await withTimeout(api.editMessageText(conv.chatId, mid, out), "editMessageText");
					} catch (err) {
						if (isNotModifiedError(err)) {
							log.debug("edit no-op — message already current", {
								conversation: conv.id,
								message: mid,
							});
							c.shown = out;
							return;
						}
						throw err;
					}
					c.shown = out;
				});
			}
			start = end;
		}
		lastEdit = Date.now();
	}

	async function stampSuperseded(): Promise<void> {
		await chain;
		const last = [...chunks].reverse().find((c) => c.id > 0);
		if (!last) return;
		const mid = last.id;
		const marked = `${last.shown}${STATUS_TAIL_MARK}⏹ superseded`;
		enqueue(async () => {
			try {
				await withTimeout(api.editMessageText(conv.chatId, mid, marked), "editMessageText");
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
		const body = rendered();
		let n = 0;
		let start = 0;
		for (let idx = 0; idx < chunks.length; idx++) {
			const c = chunks[idx]!;
			const end = idx === chunks.length - 1 ? body.length : windowEnd(body, start);
			const desired = body.slice(start, end);
			const out = desired === "" ? "…" : desired;
			if (c.id === -1 ? desired !== "" : c.shown !== out) n++;
			start = end;
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
			if (!richMode || !reasoningOn) return;
			reasoningText += delta;
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
			sendRecording();
			await sendVoice(audio);
		},
		async onFile(file) {
			await sendFile(file);
		},
		onVoiceSynthesisStart() {
			clearInterval(typing);
			sendRecording();
			const interval = setInterval(sendRecording, typingIntervalMs);
			recordings.add(interval);
			return () => {
				clearInterval(interval);
				recordings.delete(interval);
				if (recordings.size === 0 && !sinkDone && authoritative()) {
					typing = setInterval(sendTyping, typingIntervalMs);
				}
			};
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
				if (done.kind === "fenced") return;
				if (done.kind === "error") {
					enqueue(async () => {
						if (!mayDeliver()) return;
						try {
							await withTimeout(
								api.sendMessage(conv.chatId, `⚠ ${done.message.slice(0, 200)}`, {
									...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
								}),
								"sendMessage",
							);
						} catch (error) {
							if (error instanceof TelegramTimeoutError) markUncertain(error, "sendMessage error");
							throw error;
						}
					});
					await chain;
					if (uncertain) await notifyUncertain();
					return;
				}
				const content = speechContent(text);
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
						const synthesisPing = setInterval(sendRecording, TYPING_INTERVAL_MS);
						try {
							audio = await voice.synthesize(content.spoken);
						} finally {
							clearInterval(synthesisPing);
						}
					}
					if (!authoritative()) {
						log.info("voice reply fenced before delivery", { conversation: conv.id });
						return;
					}
					if (content.supplemental) {
						let failure: { error: unknown } | undefined;
						enqueue(async () => {
							if (!mayDeliver()) return;
							try {
								await withTimeout(
									api.sendMessage(conv.chatId, content.supplemental!, {
										...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
									}),
									"sendMessage",
								);
							} catch (error) {
								failure = { error };
								throw error;
							}
						});
						await chain;
						if (failure) throw failure.error;
					}
					for (const chunk of audio) await sendVoice(chunk);
					if (notice !== null) {
						enqueue(async () => {
							if (!mayDeliver()) return;
							await withTimeout(
								api.sendMessage(conv.chatId, notice, {
									...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
								}),
								"sendMessage",
							);
						});
					}
					await chain;
				} catch (err) {
					if (!authoritative()) return;
					if (err instanceof TelegramTimeoutError) {
						if (!uncertain) markUncertain(err, err.label);
						await notifyUncertain();
						return;
					}
					log.warn("voice reply delivery failed — falling back to text", err, {
						conversation: conv.id,
					});
					const fallback = text || "speech synthesis failed";
					let at = 0;
					let failed: unknown;
					while (at < fallback.length) {
						const end = windowEnd(fallback, at);
						const chunk = fallback.slice(at, end);
						enqueue(async () => {
							if (!mayDeliver()) return;
							try {
								await withTimeout(
									api.sendMessage(conv.chatId, chunk, {
										...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
									}),
									"sendMessage",
								);
							} catch (error) {
								if (error instanceof TelegramTimeoutError)
									markUncertain(error, "sendMessage fallback");
								failed = error;
								throw error;
							}
						});
						at = end;
					}
					await chain;
					if (uncertain) {
						await notifyUncertain();
						return;
					}
					if (failed) throw failed;
				}
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
				if (richMode) {
					const body = rendered();
					if (body === "") {
						log.warn("completed turn rendered empty", {
							conversation: conv.id,
							chat: conv.chatId,
							...(conv.threadId !== null ? { thread: conv.threadId } : {}),
						});
						return;
					}
					const md = reasoningBlock(RICH_LIMIT - body.length) + body;
					if (md.length > RICH_LIMIT) {
						log.warn("rich reply over cap — plain chunks from here", {
							conversation: conv.id,
							chars: md.length,
						});
						richMode = false;
					} else {
						const base = {
							...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
							...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo } } : {}),
						};
						const effect =
							done.kind === "completed" && conv.id.startsWith("dm:") && messageEffectsUsable
								? { message_effect_id: SALUTE_EFFECT_ID }
								: {};
						const keyboard = done.kind === "completed" ? buildKeyboard() : null;
						const markup = keyboard === null ? {} : { reply_markup: { inline_keyboard: keyboard } };
						try {
							let sent;
							try {
								sent = await withTimeout(
									api.sendRichMessage(
										conv.chatId,
										{ markdown: md },
										{
											...base,
											...effect,
											...markup,
										},
									),
									"sendRichMessage",
								);
							} catch (err) {
								if (effect.message_effect_id === undefined || !isPremiumGateError(err)) throw err;
								messageEffectsUsable = false;
								log.info("message effect rejected — premium gate; dropped for this process", {
									conversation: conv.id,
									chat: conv.chatId,
								});
								if (!mayDeliver()) return;
								sent = await withTimeout(
									api.sendRichMessage(conv.chatId, { markdown: md }, { ...base, ...markup }),
									"sendRichMessage",
								);
							}
							log.info("delivered rich", {
								conversation: conv.id,
								message: sent.message_id,
								...(conv.threadId !== null ? { thread: conv.threadId } : {}),
								chars: md.length,
								reasoning: md !== body,
							});
							if (done.kind === "completed") {
								if (voice) rememberReply(conv.chatId, sent.message_id, text);
								if (mayDeliver()) {
									await withTimeout(
										api.setMessageReaction(conv.chatId, sent.message_id, [
											{ type: "emoji", emoji: "🫡" },
										]),
										"setMessageReaction",
									).catch((err: unknown) => {
										log.debug("rich reaction failed", { error: String(err) });
									});
								}
							}
							return;
						} catch (err) {
							if (err instanceof TelegramTimeoutError) {
								markUncertain(err, "sendRichMessage");
								await notifyUncertain();
								return;
							}
							log.warn("rich finalize failed — falling back to plain", err, {
								conversation: conv.id,
							});
							richMode = false;
						}
					}
				}
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
						if (voice) rememberReply(conv.chatId, mid, text);
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
