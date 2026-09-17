// Delivery — streamText deltas → throttled message edits (~1/s), final
// flush on completion, typing indicator while a turn runs. This is a
// TurnSink: the runtime streams into it, grammy does the sending.

import type { Api } from "grammy";
import type { Conversation } from "../conversation.ts";
import type { TurnDone, TurnSink } from "../runtime.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";

const EDIT_INTERVAL_MS = 1_000;
const TYPING_INTERVAL_MS = 4_000;
// Leave headroom under Telegram's 4096 limit for the status block.
const CHUNK_LIMIT = 3800;
// onDone drains the queue itself — enough headroom for ~95KB of backlog.
const MAX_DRAIN_ITERATIONS = 25;
const MAX_STAGNANT = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
					await withTimeout(api.editMessageText(conv.chatId, mid, out), "editMessageText");
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
		onTextDelta(delta) {
			text += delta;
			maybeFlush();
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
			flush();
		},
		async onDone(done: TurnDone) {
			clearInterval(typing);
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
		},
	};
}
