// Delivery — streamText deltas → throttled message edits (~1/s), final
// flush on completion, typing indicator while a turn runs. This is a
// TurnSink: the runtime streams into it, grammy does the sending.

import { InputFile, type Api } from "grammy";
import type { Conversation } from "../conversation.ts";
import type { TurnDone, TurnSink } from "../runtime.ts";
import { speechContent } from "../agent/tts.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";

const EDIT_INTERVAL_MS = 1_000;
const TYPING_INTERVAL_MS = 4_000;
// Leave headroom under Telegram's 4096 limit for the status block.
const CHUNK_LIMIT = 3800;
// onDone drains the queue itself — enough headroom for ~95KB of backlog.
const MAX_DRAIN_ITERATIONS = 25;
const MAX_STAGNANT = 3;
const RECENT_REPLY_LIMIT = 256;
export const SPEAK_CALLBACK = "speak_reply";

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

function replyKey(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

function rememberReply(chatId: number, messageId: number, text: string): void {
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

// One chunk per Telegram message. id: -1 = unsent (send failed or not yet
// attempted), -2 = send in flight, otherwise the Telegram message id.
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

export function makeDeliverySink(
	api: Api,
	conv: Conversation,
	replyToMessageId: number | undefined,
	editIntervalMs = EDIT_INTERVAL_MS,
	voice?: DeliveryVoiceDeps,
): TurnSink {
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

	function enqueue(fn: () => Promise<void>): void {
		chain = chain.then(() =>
			fn().catch((err: unknown) => {
				log.warn("telegram delivery failed", { error: String(err) });
			}),
		);
	}

	function sendTyping(): void {
		withTimeout(
			api.sendChatAction(conv.chatId, "typing", {
				...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
			}),
			"sendChatAction",
		).catch((err: unknown) => {
			log.debug("typing ping failed", { error: String(err) });
		});
	}
	sendTyping();
	const typing = setInterval(sendTyping, TYPING_INTERVAL_MS);

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
	}

	async function sendVoice(audio: Uint8Array): Promise<void> {
		if (!authoritative()) return;
		enqueue(async () => {
			if (!authoritative()) return;
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
		});
		await chain;
	}

	function rendered(): string {
		const status =
			toolStatus.length > 0 ? `\n\n—\n${toolStatus.slice(-5).join("\n")}` : "";
		return text + status;
	}

	// Push the current rendered output to Telegram: fixed-position chunks
	// become messages, the trailing one is edited in place. A sent chunk
	// whose displayed content no longer matches its window gets re-edited
	// — covers both failed edits and chunks sent before their window
	// filled.
	function flush(): void {
		const body = rendered();
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
					try {
						const sent = await withTimeout(
							api.sendMessage(conv.chatId, out, {
								...(conv.threadId !== null
									? { message_thread_id: conv.threadId }
									: {}),
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
					} catch (err) {
						replyTo = undefined; // never retry the reply link
						c.id = -1; // failed — retried by the next flush
						throw err;
					}
				});
				break; // strictly ordered — later chunks go out on a later flush
			}
			if (c.shown !== out) {
				const mid = c.id;
				enqueue(async () => {
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

	return {
		setAuthorityCheck(check) {
			authoritative = check;
		},
		onTextDelta(delta) {
			text += delta;
			if (!voice?.voiceMode) maybeFlush();
		},
		onReasoningDelta() {
			// Thinking stays in history, not in the chat stream.
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
		async onDone(done: TurnDone) {
			clearInterval(typing);
			if (voice?.voiceMode) {
				if (done.kind === "fenced") return;
				if (done.kind === "error") {
					enqueue(async () => {
						await withTimeout(
							api.sendMessage(conv.chatId, `⚠ ${done.message.slice(0, 200)}`, {
								...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
							}),
							"sendMessage",
						);
					});
					await chain;
					return;
				}
				const content = speechContent(text);
				try {
					let audio: Uint8Array[] = [];
					if (content.spoken !== "") {
						sendRecording();
						const recording = setInterval(sendRecording, TYPING_INTERVAL_MS);
						try {
							audio = await voice.synthesize(content.spoken);
						} finally {
							clearInterval(recording);
						}
					}
					if (!authoritative()) {
						log.info("voice reply fenced before delivery", { conversation: conv.id });
						return;
					}
					if (content.supplemental) {
						enqueue(async () => {
							if (!authoritative()) return;
							await withTimeout(
								api.sendMessage(conv.chatId, content.supplemental!, {
									...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
								}),
								"sendMessage",
							);
						});
					}
					for (const chunk of audio) await sendVoice(chunk);
					await chain;
				} catch (err) {
					if (!authoritative()) return;
					log.warn("voice reply synthesis failed", {
						conversation: conv.id,
						error: String(err),
					});
					enqueue(async () => {
						if (!authoritative()) return;
						await withTimeout(
							api.sendMessage(conv.chatId, text || "speech synthesis failed", {
								...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
							}),
							"sendMessage",
						);
					});
					await chain;
				}
				return;
			}
			if (done.kind === "error") {
				toolStatus.push(`⚠ ${done.message.slice(0, 200)}`);
			} else if (done.kind === "fenced") {
				// Fenced turns abort quietly — nothing emitted, nothing sent.
				if (text === "" && toolStatus.length === 0) return;
				toolStatus.push("⏹ superseded");
			}
			// Final flush. No flush runs after this, so drain here: keep
			// flushing while chunks remain unsent, retrying failures with a
			// short backoff. Give up loudly rather than dropping the tail.
			let prevPending = Number.POSITIVE_INFINITY;
			let stagnant = 0;
			for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
				flush();
				await chain;
				const pending = pendingCount();
				if (pending === 0) {
					// Sends that resolved inside `await chain` were still
					// in flight when the flush above ran, so their (possibly
					// drifted) windows were never re-checked — one last
					// pass patches them.
					flush();
					await chain;
					break;
				}
				stagnant = pending >= prevPending ? stagnant + 1 : 0;
				prevPending = pending;
				if (stagnant >= MAX_STAGNANT) {
					log.warn("delivery gave up on unsent chunks", {
						conversation: conv.id,
						unsent: pending,
					});
					break;
				}
				await sleep(300 * stagnant);
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
					if (voice) rememberReply(conv.chatId, mid, text);
					enqueue(async () => {
						await withTimeout(
							api.setMessageReaction(conv.chatId, mid, [
								{ type: "emoji", emoji: "🫡" },
							]),
							"setMessageReaction",
						);
					});
					if (voice) {
						enqueue(async () => {
							try {
								await withTimeout(
									api.editMessageReplyMarkup(conv.chatId, mid, {
										reply_markup: {
											inline_keyboard: [[{ text: "🔊", callback_data: SPEAK_CALLBACK }]],
										},
									}),
									"editMessageReplyMarkup",
								);
							} catch (err) {
								// Button already stamped — benign, not a failure.
								if (isNotModifiedError(err)) return;
								throw err;
							}
						});
					}
					await chain;
				}
			}
		},
	};
}
