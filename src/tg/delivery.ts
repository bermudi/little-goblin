// Delivery — streamText deltas → throttled message edits (~1/s), final
// flush on completion, typing indicator while a turn runs. This is a
// TurnSink: the runtime streams into it, grammy does the sending.

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
// Rich draft keep-alive: re-push an unchanged draft at this age so the
// 30 s Telegram TTL never expires mid-turn. Parameterized for tests the
// same way typingIntervalMs is.
const DRAFT_TTL_MS = 20_000;
// Leave headroom under Telegram's 4096 limit for the status block.
const CHUNK_LIMIT = 3800;
// Rich messages cap at 32768 chars (Bot API 10.3); headroom under the
// cap for the reasoning block's markup and the status tail.
const RICH_LIMIT = 32_000;
// The reasoning block's fixed markup, plus one char for the tail-cut
// "…" marker — the budget check below sizes the escaped text into
// what's left of the send.
const REASONING_BLOCK_OVERHEAD =
	"<details><summary>Thinking</summary>\n<pre></pre>\n</details>\n\n".length + 1;
// Draft ids must be non-zero; updates under one id animate. A process
// counter is enough — drafts are ephemeral and chat-local. Two per rich
// sink: the answer bubble and, when showReasoning is on, the reasoning
// bubble ahead of it.
let nextDraftId = 1;

// The completed-turn salute: the send itself carries the message effect
// matching the 🫡 reaction (private chats only — the DM door). The id was
// pinned against the live API, which rejects garbage with
// EFFECT_ID_INVALID. Effects are premium-gated at the receiving chat:
// PREMIUM_ACCOUNT_REQUIRED is a definite 400 (nothing landed), so the
// one safe retry drops the param, and the memo keeps every later turn
// this process to a single send. A restart re-probes.
const SALUTE_EFFECT_ID = "4913930782671635058";
let messageEffectsUsable = true;

/** Test door for the process-lifetime premium memo. */
export function resetMessageEffectsGateForTests(): void {
	messageEffectsUsable = true;
}

function isPremiumGateError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("PREMIUM_ACCOUNT_REQUIRED");
}
// onDone drains the queue itself — enough headroom for ~95KB of backlog.
const MAX_DRAIN_ITERATIONS = 25;
const MAX_STAGNANT = 3;
const RECENT_REPLY_LIMIT = 256;
const UNCERTAIN_NOTICE = "⚠ Delivery uncertain—check Telegram before retrying.";
export const SPEAK_CALLBACK = "speak_reply";

// Genuine cross-instance singleton: written by whichever delivery sink
// rendered a reply, read later by the 🔊 speak button — a different
// handler with no link to that (long-gone) sink, keyed by Telegram-global
// message ids. No per-sink home exists; per-sink state would strand every
// reply the moment its sink closed.
const recentReplies = new Map<string, string>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Telegram answers an edit whose content is identical with 400
// "message is not modified" — benign, not a failure. The drain counts a
// failed edit as still-pending and retries it; without this carve-out one
// no-op edit makes the drain give up and skips the 🫡 + 🔊 on a turn that
// actually delivered. Treat it as success: the message already shows what
// we wanted.
export function isNotModifiedError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		// The stable identifier is the code: Telegram/grammy errors carry
		// error_code 400 for this no-op. A phrase match alone would fire on
		// any coincidental wording with a different failure class.
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some(
		(h) => typeof h === "string" && h.toLowerCase().includes("message is not modified"),
	);
}

export interface DeliveryVoiceDeps {
	synthesize(text: string): Promise<Uint8Array[]>;
	voiceMode: boolean;
}

// The 👍/👎 row rides every completed reply this dep is wired into. It
// resolves the landed reply's anchor at stamp time — after the turn's
// append — so the buttons' payload carries the reply's durable identity.
// The conversation store satisfies it.
export interface DeliveryRatingDeps {
	lastReplyAnchor(conversationId: string): number | null;
}

// Rich replies (design/telegram.md, ruling 2026-10-12): draft streaming
// and one markdown render per DM turn. `enabled` is the config kill
// switch (telegram.richReplies); DM gating and voice-mode exclusion
// happen in the sink. `reasoning` is telegram.showReasoning.
export interface RichSinkOpts {
	enabled?: boolean;
	reasoning?: boolean;
}

function replyKey(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

// The forced-landing stamp (design/model.md): a loop-cut answer is
// degraded goods — telegram reads that on the reply itself, riding the
// status-tail mark so TTS never speaks it.
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

// Exported for speak-button tests: prime the reply cache directly
// instead of driving a full delivery sink to completion.
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

// One chunk per Telegram message. id: -1 = unsent (definite failure or not yet
// attempted), -2 = send in flight or timed out (outcome unknown), otherwise
// the Telegram message id.
// shown = the content we believe the message displays. A chunk sent early
// as the trailing message can later slide into the middle of the stream;
// its window then outgrows what it shows, so it gets patched with an edit
// — no slice of the output is silently dropped.
interface Chunk {
	id: number;
	shown: string;
}

// Slicing between a high and a low surrogate produces a lone surrogate —
// not valid text, and Telegram may reject or mangle the message. Window
// boundaries are nudged so a pair never splits across two messages.
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

// The end of the window starting at `start`: CHUNK_LIMIT ahead, pulled
// back one code unit if that lands inside a surrogate pair. Boundaries
// are recomputed every flush — the body's status tail can still change
// under a fixed seam, so a seam computed against provisional chars may
// drift by one; the shown≠desired re-edit below heals it. Once stream
// text covers the seam the chars are final and it never moves again.
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

// Telegram adapter type; domain wake ports expose only TurnSink.
export type DeliveryApi = Api;

export function makeDeliverySink(
	api: Api,
	conv: Conversation,
	replyToMessageId: number | undefined,
	editIntervalMs = EDIT_INTERVAL_MS,
	voice?: DeliveryVoiceDeps,
	typingIntervalMs = TYPING_INTERVAL_MS,
	maxDrainIterations = MAX_DRAIN_ITERATIONS,
	rating?: DeliveryRatingDeps,
	rich?: RichSinkOpts,
	// How long a photo-path file holds for burst siblings before its
	// album (or solo send) goes out.
	mediaGroupWindowMs = 400,
	// Age at which an unchanged rich draft is re-pushed (TTL keep-alive).
	draftTtlMs = DRAFT_TTL_MS,
): TurnSink {
	// Routing bug alarm (DESIGN.md, App channel): app conversations have
	// no Telegram door — their sink is the HTTP stream. A silent send
	// into the chat_id filler is worse than a throw.
	if (channelOf(conv.id) === "app") {
		throw new Error(`telegram delivery sink requested for app conversation ${conv.id}`);
	}
	let text = "";
	const toolStatus: string[] = [];
	// At most one send is in flight and it is always the earliest unsent
	// chunk, so messages can't land out of order.
	const chunks: Chunk[] = [];
	let lastEdit = 0;
	// Serialized api calls — edits must not race sends. The chain never
	// rejects: each link logs its own failure, so `await chain` is always
	// safe and onDone can't throw on a delivery error.
	let chain: Promise<void> = Promise.resolve();
	// Reply threading is cosmetic — if a send fails (e.g. the operator
	// deleted the triggering message), retries go out without it rather
	// than failing forever.
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
	// Typing indicator state. `let` because onVoiceSynthesisStart pauses
	// it and a synthesis stopper resumes it. Parallel speak calls overlap,
	// so every live record_voice interval is tracked in a set — a single
	// shared handle would orphan all but the newest interval and make a
	// stopper clear the wrong one.
	let typing = setInterval(sendTyping, typingIntervalMs);
	const recordings = new Set<ReturnType<typeof setInterval>>();
	// onDone is terminal: a synthesis stopper firing after it must not
	// restart a typing indicator on a dead sink.
	let sinkDone = false;

	// Rich mode degrades to the plain path on any rich failure — the
	// reply never hangs on formatting. DMs only; voice turns own their
	// delivery; guests never get here (guest.ts passes no opts).
	const richOpts = rich;
	const answerDraftId = nextDraftId++;
	const reasonDraftId = nextDraftId++;
	let richMode = richOpts?.enabled === true && conv.id.startsWith("dm:") && !voice?.voiceMode;
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
		// The chat-status indicator stays live in rich mode too: drafts
		// carry content, the chat action carries liveness. While a
		// synthesis window is open the record_voice interval owns the
		// status bar instead.
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
	// Telegram clears the chat action when a real message lands, and the
	// next tick is up to typingIntervalMs away — dead air while the turn
	// is still busy. Re-ping right after a mid-turn send; skipped while a
	// synthesis window owns the status bar and once the sink is done (no
	// ghost typing on a finished turn).
	function repingTyping(): void {
		if (sinkDone || recordings.size > 0 || !mayDeliver()) return;
		pingTyping();
	}
	// Draft refresh policy for rich mode: push only on new content or TTL
	// keep-alive — identical re-sends would re-animate the bubble every
	// 4 s. The reasoning bubble's own growth/staleness counts too: a long
	// thinking stretch with no answer text must still keep its draft alive.
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
		// Synthesis pauses the typing interval, which otherwise carries
		// the draft keep-alive — without this a long synthesis lets the
		// draft evaporate mid-turn (30 s TTL) while record_voice runs.
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
		// A landed voice note clears the chat action — restore the typing
		// indicator immediately instead of waiting out the tick.
		repingTyping();
		if (uncertain) {
			throw new Error(
				"Telegram delivery uncertain — voice not sent again; check Telegram before retrying",
			);
		}
	}

	// Multi-image turns arrive as a burst: one model step fires several
	// send_file calls in parallel, and their deliver() calls land within
	// milliseconds of each other. Photo-path files hold in a short batch
	// window so the burst shares one album; a lone photo just pays the
	// window once. Documents (as_file, GIFs, non-images) never wait and
	// never flush the batch — a doc whose stat resolves mid-burst would
	// split the album for a purely cosmetic ordering win.
	interface QueuedPhoto {
		file: OutgoingFile;
		// Filled by the batch link's stat; the joiner pushes before any
		// await, so a parallel burst joins in one deterministic tick.
		bytes: number;
		// Set by the batch link when this file definitively failed or went
		// uncertain. undefined = delivered (or fenced-skip, same as the
		// solo path's silent return).
		error?: unknown;
	}
	let photoQueue: QueuedPhoto[] = [];
	let photoBatchWait: Promise<void> | null = null;
	let photoBatchResolve: (() => void) | null = null;
	let photoKick: ReturnType<typeof setTimeout> | null = null;

	function flushPhotoBatch(): void {
		if (photoBatchResolve === null) return; // no open batch
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
		if (!mayDeliver()) return; // entries stay error-free: fenced = skipped
		const thread = conv.threadId !== null ? { message_thread_id: conv.threadId } : {};
		// Late stat — the joiner pushed before any await, so the vanished-
		// file guard lives here: a file that died between the tool's check
		// and this link fails alone and never takes the burst down.
		const sendable: QueuedPhoto[] = [];
		for (const q of batch) {
			try {
				q.bytes = (await stat(q.file.path)).size;
				sendable.push(q);
			} catch {
				q.error = new Error(`file unreadable: ${q.file.path}`);
			}
		}
		try {
			// Telegram caps an album at 10 items; a bigger burst splits.
			for (let at = 0; at < sendable.length; at += 10) {
				const group = sendable.slice(at, at + 10);
				if (group.length === 1) {
					await sendPhotoSolo(group[0]!, thread);
					continue;
				}
				const media = group.map((q) => ({
					type: "photo" as const,
					media: new InputFile(q.file.path, q.file.filename),
					...(q.file.caption !== undefined ? { caption: q.file.caption } : {}),
				}));
				const sent = await withTimeout(
					api.sendMediaGroup(conv.chatId, media, thread),
					"sendMediaGroup",
				);
				log.debug("media group delivered", {
					conversation: conv.id,
					messages: sent.length,
					files: group.length,
					...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				});
				repingTyping();
			}
			return;
		} catch (err) {
			if (!(err instanceof TelegramTimeoutError)) {
				// Definite failure: the album provably never landed, so the
				// whole burst degrades to solo sends — one bad photo doesn't
				// take the rest down. Solo failures (including their own
				// timeouts) record per file below.
				log.warn("media group failed — falling back to solo sends", err, {
					conversation: conv.id,
					chat: conv.chatId,
					files: sendable.length,
				});
			} else {
				// A group timeout is as ambiguous as a solo one — the album
				// may have landed. Mark the sink so the remaining delivery
				// stops, and fail every file in the burst as uncertain.
				markUncertain(err, "sendMediaGroup");
				const wrapped = new DeliveryUncertainError(err);
				for (const q of sendable) q.error = wrapped;
				return;
			}
		}
		for (const q of sendable) {
			try {
				await sendPhotoSolo(q, thread);
			} catch (err) {
				q.error = err;
			}
		}
	}

	async function sendFile(file: OutgoingFile): Promise<void> {
		if (!authoritative()) return;
		// Images go as photo previews, everything else as documents —
		// sniffed from magic bytes, never the extension. Two things force
		// the document path: as_file (sendPhoto re-encodes — a document is
		// byte-exact) and GIFs (sendPhoto strips animation). Sniffing is
		// sync, so a photo joins its burst before the first await.
		const sniff = sniffImage(file.path);
		const photo = !file.asFile && sniff !== null && sniff.mediaType !== "image/gif";
		if (photo) {
			const q: QueuedPhoto = { file, bytes: 0 };
			const wait = joinPhotoBatch(q);
			// The batch's verdict for THIS file — a group failure degrades
			// to solo sends, so siblings can succeed while this one fails.
			await wait;
			if (q.error !== undefined) throw q.error;
			return;
		}
		// Fail fast on a file that vanished between the tool's check and
		// now, so the tool reports it. Send failures below reject too —
		// see the sentinel comment there.
		const st = await stat(file.path).catch((err: unknown) => {
			throw new Error(`file unreadable: ${file.path} (${String(err)})`);
		});
		return sendDocumentSolo(file, st.size);
	}

	async function sendDocumentSolo(file: OutgoingFile, bytes: number): Promise<void> {
		if (bytes > MAX_SEND_BYTES)
			throw new Error(`file too large: ${file.path} (${bytes} bytes, max ${MAX_SEND_BYTES})`);
		// The chain never rejects (onDone awaits it bare), so a failed
		// send can't travel through it. The link records the failure and
		// rethrows — the chain's catch still warn-logs it — and the
		// rethrow below rejects sendFile, the tool's only honest "it
		// didn't arrive" signal. Unlike text chunks, a file send gets no
		// drain retry: swallowing it makes send_file report a sent file
		// the operator never saw.
		let failure: { err: unknown } | undefined;
		enqueue(async () => {
			if (!authoritative()) return;
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
					// A file-send timeout is as ambiguous as a text one — the
					// upload may have landed. Mark the sink so the remaining
					// text/reaction stop and the notice goes out, and fail the
					// tool as uncertain rather than "didn't arrive".
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

	// Shared rich-failure policy for the draft sends: a draft is an
	// ephemeral preview — nothing real can have landed, so even a
	// timeout is a stall, never delivery uncertainty. Every draft
	// failure degrades the turn to the plain path; the reply is never
	// lost to a dead preview. The real sendRichMessage keeps
	// markUncertain — its timeout means the reply may be live.
	function richFailure(err: unknown, method: string): never {
		log.warn("rich delivery failed — falling back to plain", err, {
			conversation: conv.id,
			chat: conv.chatId,
			method,
		});
		richMode = false;
		throw err;
	}

	// Serialized draft updates: the reasoning bubble (when enabled) and
	// the answer bubble. An empty body renders as the client's "Thinking…"
	// placeholder; a markdown body is the live preview. Rich messages
	// can't be edited, so the preview accumulates under one draft id and
	// the 30 s TTL rides the typing tick above.
	function pushDrafts(body: string): void {
		// The reasoning bubble appears with the first reasoning delta —
		// an empty draft pushed at sink start would sit there as a
		// second perpetual "Thinking…" bubble on turns with no
		// reasoning at all. Once live it re-pushes on growth or
		// staleness: it stops growing early and would otherwise
		// evaporate mid-turn (30 s TTL) while the answer keeps
		// refreshing. The enqueued fns re-check richMode — a mid-turn
		// degrade must not fire queued drafts at a dead path.
		if (
			richOpts?.reasoning === true &&
			reasoningText !== "" &&
			(reasoningText.length !== reasoningPushed || Date.now() - reasoningSentAt > 20_000)
		) {
			const snap = reasoningText;
			reasoningPushed = snap.length;
			reasoningSentAt = Date.now();
			enqueue(async () => {
				if (!mayDeliver() || !richMode) return;
				// The draft renders inside the client's native thinking block
				// (Bot API 10.2) — the raw text stays literal, tail-capped:
				// it's a preview; the final message's collapsed block carries
				// the fuller cut.
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

	// Collapsed reasoning block for the final rich message. Syntax pinned
	// by probe 2026-10-12: <details>/<summary> renders collapsed in the
	// rich markdown dialect; <tg-details> does not parse. Reasoning is
	// raw text, not markdown — the <pre> wrapper keeps **, $$, ||
	// spoilers and [x](y) literal instead of parsed (or 400-ing the
	// send); HTML metachars still need escaping, & before <. The block
	// sizes itself into the send's remaining budget so a long reply
	// never pushes the combined markdown over the cap — drops out
	// entirely when there's no room.
	function reasoningBlock(budget: number): string {
		if (richOpts?.reasoning !== true) return "";
		const trimmed = reasoningText.trim();
		if (trimmed === "") return "";
		// Escape before measuring — entities expand up to 5x.
		const escaped = trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		const room = Math.min(8_000, budget - REASONING_BLOCK_OVERHEAD);
		if (room <= 0) return "";
		if (escaped.length <= room) {
			return `<details><summary>Thinking</summary>\n<pre>${escaped}</pre>\n</details>\n\n`;
		}
		// A slice that opens mid-entity ("&am…") would print the fragment
		// literally — when a ';' shows before the first '&' the cut
		// landed inside one; drop it.
		let tail = escaped.slice(-room);
		const semi = tail.indexOf(";");
		const amp = tail.indexOf("&");
		if (semi !== -1 && (amp === -1 || semi < amp)) tail = tail.slice(semi + 1);
		return `<details><summary>Thinking</summary>\n<pre>…${tail}</pre>\n</details>\n\n`;
	}

	// Push the current rendered output to Telegram: fixed-position chunks
	// become messages, the trailing one is edited in place. A sent chunk
	// whose displayed content no longer matches its window gets re-edited
	// — covers both failed edits and chunks sent before their window
	// filled.
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
		// Seams are recomputed each flush so both neighbours share one
		// value — a drifted boundary re-edits the sent chunk instead of
		// leaving a duplicated or dropped character between messages.
		let start = 0;
		for (let idx = 0; idx < chunks.length; idx++) {
			const c = chunks[idx]!;
			if (c.id === -2) break; // send in flight — wait it out
			const isLast = idx === chunks.length - 1;
			const end = isLast ? body.length : windowEnd(body, start);
			const desired = body.slice(start, end);
			const out = desired === "" ? "…" : desired;
			if (c.id === -1) {
				// Window emptied before the send — the status tail shrank
				// past it. Nothing to send; later windows are empty too.
				if (desired === "") break;
				c.id = -2;
				c.shown = out;
				enqueue(async () => {
					if (!mayDeliver()) {
						c.id = -1; // queued, never sent; don't leave a phantom in-flight chunk
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
						// The chunk landing cleared the chat action — restore it now;
						// the finalize drain (sinkDone) stays silent.
						repingTyping();
					} catch (err) {
						// API-level Grammy errors (400s etc.) provably never
						// landed, so retry on the next flush. Transport-level
						// failures — a TypeError from fetch, or a known
						// network error such as ECONNRESET — are ambiguous:
						// Telegram may have committed the message before the
						// response was lost (audit D2). A generic Error stays
						// a definite failure so test/edge callers keep retry.
						// A grammy HttpError wraps the underlying fetch/transport
						// failure in `.error`; treat only those as ambiguous, so a
						// programming throw (bad payload, etc.) fails fast instead
						// of stopping the drain as "uncertain" (audit P1).
						const transportCause =
							err instanceof HttpError ? (err.error as { code?: unknown } | null) : null;
						const transportError =
							transportCause !== null &&
							typeof transportCause === "object" &&
							typeof transportCause.code === "string";
						if (err instanceof TelegramTimeoutError || (!(err instanceof GrammyError) && transportError)) {
							markUncertain(err, "sendMessage", idx);
						} else {
							replyTo = undefined; // never retry the reply link
							c.id = -1; // definite failure — retry on next flush
						}
						throw err;
					}
				});
				break; // strictly ordered — later chunks go out on a later flush
			}
			if (c.shown !== out) {
				const mid = c.id;
				enqueue(async () => {
					if (!mayDeliver()) return;
					try {
						await withTimeout(api.editMessageText(conv.chatId, mid, out), "editMessageText");
					} catch (err) {
						if (isNotModifiedError(err)) {
							// Already shows `out` — adopt it so the drain
							// sees no pending work instead of retrying a
							// no-op until it gives up and skips the 🫡 + 🔊.
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

	// Cancellation is the sole post-fence edit: label only a bubble that
	// actually landed, using what it showed rather than unsent stream text.
	// In-flight sends have already settled by the time this runs.
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

	// Chunks that still need Telegram work: never-sent ones with a
	// non-empty window, plus sent ones whose shown content no longer
	// matches their current window — a failed edit counts here, so the
	// drain retries it instead of declaring victory.
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

	// One keyboard, one edit — editMessageReplyMarkup replaces the whole
	// markup, so the rating row and 🔊 stamp together or the second call
	// erases the first. Shared by the plain and rich finalize paths; on a
	// rich message the edit lands after the send (probed working).
	function buildKeyboard(): Array<Array<{ text: string; callback_data: string }>> | null {
		if (rating === undefined && voice === undefined) return null;
		const anchor = rating?.lastReplyAnchor(conv.id) ?? null;
		// One compact row per reply: 👍/👎 and 🔊 share it when both are on.
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
			// Off or plain path: thinking stays in history, not in the chat
			// stream — unchanged. Rich + showReasoning streams it into its
			// own draft bubble (design/telegram.md).
			if (!richMode || richOpts?.reasoning !== true) return;
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
		// DESIGN.md (TTS): record_voice runs while synthesis is in flight —
		// the speak tool's door, matching the 🔊 button and /voice mode.
		// Typing pauses for the duration; the stopper restores it only when
		// the turn is still live (a fenced turn must not ghost a typing
		// indicator after onDone already tore the sink down).
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
			// The forced-landing stamp joins the body BEFORE the final flush,
			// so the drain's re-edit publishes it on the last bubble and the
			// 🫡 still lands on the same (now stamped) message.
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
				// A completed turn that renders to nothing — no spoken text,
				// no supplemental, no forced-landing notice — would end in
				// total silence: no voice note, no bubble, no log line
				// (finding 15). Warn with the address; the delivery contract
				// sanctions a short chat message for errors only, so no
				// placeholder bubble is invented here.
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
						// Local to this synthesis — distinct from the speak-tool
						// indicator state above (already torn down by onDone).
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
					// The stamp is visual — speechContent strips the status
					// tail from spoken text — so voice turns ship it as its own
					// notice line after the audio, not inside it.
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
			// Rich finalize: one markdown send replaces the chunk drain. The
			// drafts vanish when the send lands; 🫡 + keyboard ride the rich
			// message (reply anchors, reactions and markup edits all work on
			// rich messages — probed live 2026-10-12). A failure falls through
			// to the plain drain with the same body.
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
				// Draft failures during that await degrade the turn — re-check
				// before committing to the rich send; false falls through to
				// the plain drain below.
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
					// The reasoning block shares the one rich send and sizes
					// into the body's remaining budget. A body that outgrew
					// the cap between the last flush and onDone skips the
					// doomed send and drains plain instead.
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
						// The keyboard rides the send itself — one call, no
						// post-land editMessageReplyMarkup window where the
						// reply sits buttonless. The premium-gate retry keeps
						// it; only the effect param drops.
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
								await withTimeout(
									api.setMessageReaction(conv.chatId, sent.message_id, [
										{ type: "emoji", emoji: "🫡" },
									]),
									"setMessageReaction",
								).catch((err: unknown) => {
									log.debug("rich reaction failed", { error: String(err) });
								});
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
			// Final flush. No flush runs after this, so drain here: keep
			// flushing while chunks remain unsent, retrying failures with a
			// short backoff. Give up loudly rather than dropping the tail.
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
					// Sends that resolved inside `await chain` were still
					// in flight when the flush above ran, so their (possibly
					// drifted) windows were never re-checked — one last
					// pass patches them.
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
			// Safety net for a burst whose window outlives the turn — every
			// send_file tool call resolved before onDone, so this is normally
			// a no-op. After the drain, so the link joins the awaited chain.
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
			// Steady progress on a backlog bigger than the drain budget
			// never trips the stagnant guard — the loop simply runs out of
			// iterations and the tail would drop silently. Same failure,
			// same warn (and the 🫡 check below still sees the residue).
			const unsent = pendingCount();
			if (unsent > 0 && !gaveUp) {
				log.warn("delivery gave up on unsent chunks", {
					conversation: conv.id,
					unsent,
				});
			}
			// Per-turn mode line (design/telegram.md): rich turns name
			// their send in "delivered rich"; a plain turn — kill switch,
			// non-DM, or a mid-turn degrade — must be identifiable too,
			// not just per-message debug lines.
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
			// Clean finish → 🫡 on the last bubble. The turn's end-marker:
			// visible, silent (reactions don't notify), and it rides the
			// exact message that finished. Errors already surface as ⚠ in
			// the body; fenced turns end quietly by design. Cosmetic — a
			// failure is the enqueue warn, never the turn's.
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
					// One keyboard, one edit — see buildKeyboard above.
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
								// Buttons already stamped — benign, not a failure.
								if (isNotModifiedError(err)) return;
								throw err;
							}
						});
					}
					await chain;
					if (!mayDeliver()) await stampSuperseded();
				} else {
					// Same empty-render warn as the voice path (finding 15):
					// reaching the clean-finish check with no sent chunk means
					// no text, no tool status, no forced notice ever rendered —
					// the operator saw typing… then nothing. Warn with the
					// address rather than inventing a bubble the delivery
					// contract doesn't provide for.
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
