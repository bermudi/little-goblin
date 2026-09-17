// Delivery — streamText deltas → throttled message edits (~1/s), final
// flush on completion, typing indicator while a turn runs. This is a
// TurnSink: the runtime streams into it, grammy does the sending.

import type { Api } from "grammy";
import type { Conversation } from "../conversation.ts";
import type { TurnDone, TurnSink } from "../runtime.ts";
import { log } from "../log.ts";

const EDIT_INTERVAL_MS = 1_000;
const TYPING_INTERVAL_MS = 4_000;
// Leave headroom under Telegram's 4096 limit for the status block.
const CHUNK_LIMIT = 3800;

export function makeDeliverySink(
	api: Api,
	conv: Conversation,
	replyToMessageId: number | undefined,
): TurnSink {
	let text = "";
	const toolStatus: string[] = [];
	// One entry per sent/sending message; -1 while its send is still queued.
	const messageIds: number[] = [];
	let lastEdit = 0;
	// Serialize every api call — edits must not race sends.
	let chain: Promise<void> = Promise.resolve();

	function enqueue(fn: () => Promise<void>): void {
		chain = chain.then(fn, (err: unknown) => {
			log.warn("telegram delivery failed", { error: String(err) });
		});
	}

	const typing = setInterval(() => {
		api.sendChatAction(conv.chatId, "typing", {
			...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
		}).catch(() => {});
	}, TYPING_INTERVAL_MS);

	function rendered(): string {
		const status =
			toolStatus.length > 0 ? `\n\n—\n${toolStatus.slice(-5).join("\n")}` : "";
		return text + status;
	}

	// Push the current rendered output to Telegram: new fixed-position
	// chunks become new messages, the last one gets edited in place.
	function flush(): void {
		const body = rendered();
		const needed = Math.ceil(body.length / CHUNK_LIMIT);
		while (messageIds.length < needed) {
			const idx = messageIds.length;
			const chunk = body.slice(idx * CHUNK_LIMIT, (idx + 1) * CHUNK_LIMIT);
			messageIds.push(-1);
			enqueue(async () => {
				const sent = await api.sendMessage(conv.chatId, chunk, {
					...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
					...(idx === 0 && replyToMessageId !== undefined
						? { reply_parameters: { message_id: replyToMessageId } }
						: {}),
				});
				messageIds[idx] = sent.message_id;
			});
		}
		const lastIdx = messageIds.length - 1;
		if (lastIdx < 0) return;
		const tail = body.slice(lastIdx * CHUNK_LIMIT);
		enqueue(async () => {
			const id = messageIds[lastIdx];
			if (id === undefined || id === -1) return; // send failed; next flush retries
			await api.editMessageText(conv.chatId, id, tail === "" ? "…" : tail);
		});
		lastEdit = Date.now();
	}

	function maybeFlush(): void {
		if (Date.now() - lastEdit >= EDIT_INTERVAL_MS) flush();
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
			flush();
			await chain;
		},
	};
}
