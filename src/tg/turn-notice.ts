import type { Api } from "grammy";
import { APP_ID_PREFIX } from "../conversation-address.ts";
import type { ConversationStore } from "../conversation.ts";
import { parseEvent } from "../conversation-events.ts";
import { log } from "../log.ts";
import type { TurnJournal, TurnRun } from "../turn-journal.ts";
import { withTimeout } from "./deadline.ts";
import { chunkWindows } from "./delivery-text.ts";

export function sendInterruptedTurnNotices(
	api: Api,
	runs: readonly TurnRun[],
	operators: readonly number[],
	titleFor: (conversationId: string) => string | undefined,
): void {
	void Promise.allSettled(
		runs.flatMap((run) => {
			// The notice lands in the operator DM, but /resume resolves against
			// the conversation the command arrives in — say where to send it.
			// App lanes are unreachable from Telegram; only the app surfaces
			// them (its /interrupted route).
			const resumeHow = run.conversationId.startsWith(APP_ID_PREFIX)
				? "open that conversation in the app to resume it — Telegram /resume can't reach app lanes."
				: `resume explicitly with /resume ${run.runId.slice(0, 8)} sent in that conversation, not in this DM.`;
			const text =
				`interrupted turn ${run.runId.slice(0, 8)} — ` +
				`${titleFor(run.conversationId) ?? run.conversationId}, started ${new Date(run.startedMs).toISOString()}: ` +
				`${run.calls.completed} completed, ${run.calls.dispatched} dispatched (ambiguous), ` +
				`${run.calls.resolved} decided, ${run.calls.planned} planned tool call(s). ` +
				`The turn was not replayed — ${resumeHow}`;
			return operators.map(async (chat) => {
				try {
					await withTimeout(api.sendMessage(chat, text), "sendMessage (interrupted turn notice)");
					log.info("interrupted turn notice sent", {
						run: run.runId,
						conversation: run.conversationId,
						chat,
						started: new Date(run.startedMs).toISOString(),
						calls: run.calls,
					});
				} catch (err) {
					log.error("interrupted turn notice send failed", err, {
						run: run.runId,
						conversation: run.conversationId,
						chat,
					});
				}
			});
		}),
	);
}

// #481 — accepted user input the dead process fenced before any turn
// admitted it: one line per conversation, separate from the per-run
// interrupted notices (those describe turns that DID run). Notice
// only — resume/reply remains the operator's move.
export function sendStrandedInputNotices(
	api: Api,
	counts: ReadonlyMap<string, number>,
	operators: readonly number[],
	titleFor: (conversationId: string) => string | undefined,
): void {
	void Promise.allSettled(
		[...counts.entries()].flatMap(([conversationId, n]) => {
			const how = conversationId.startsWith(APP_ID_PREFIX)
				? "open that conversation in the app to continue"
				: "send /resume or reply to continue";
			const text =
				`${titleFor(conversationId) ?? conversationId}: ` +
				`${n} message(s) you sent before the restart weren't answered — ${how}`;
			return operators.map(async (chat) => {
				try {
					await withTimeout(
						api.sendMessage(chat, text),
						"sendMessage (stranded input notice)",
					);
					log.info("stranded input notice sent", {
						conversation: conversationId,
						chat,
						stranded: n,
					});
				} catch (err) {
					log.error("stranded input notice send failed", err, {
						conversation: conversationId,
						chat,
						stranded: n,
					});
				}
			});
		}),
	);
}

// #482 — a run whose reply committed durably but whose process died in
// the delivery window owes the channel that text, not a notice. Re-send
// the landed reply to the conversation's own chat, chunked like the
// delivery sink, then claim the delivery so no later boot sends it
// again. A send failure leaves the row pending — the next boot retries.
// Rows without a recorded reply seq (pre-column) are skipped here and
// keep their interrupted notice. App lanes have nothing to push — the
// reply IS history — so their stamp settles without a send. Returns the
// run ids marked delivered, for excluding them from the notices.
export async function redeliverLandedReplies(
	api: Api,
	runs: readonly TurnRun[],
	store: ConversationStore,
	journal: TurnJournal,
): Promise<ReadonlySet<string>> {
	const delivered = new Set<string>();
	for (const run of runs) {
		const conv = store.get(run.conversationId);
		if (conv === null) {
			log.warn("landed reply re-delivery skipped — conversation gone", undefined, {
				run: run.runId,
				conversation: run.conversationId,
			});
			continue;
		}
		if (conv.chatId === 0) {
			if (journal.markReplyDelivered(run.runId)) {
				delivered.add(run.runId);
				log.info("landed reply settled — app lane reads history", {
					run: run.runId,
					conversation: run.conversationId,
				});
			}
			continue;
		}
		if (run.replySeq === null) continue;
		const row = store.db
			.query<{ role: string; data: string }, [string, number]>(
				"SELECT role, data FROM events WHERE conversation_id = ? AND seq = ?",
			)
			.get(run.conversationId, run.replySeq);
		const message =
			row === null ? null : parseEvent(run.conversationId, run.replySeq, row.role, row.data);
		const text =
			message === null
				? ""
				: message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
		if (text === "") {
			log.warn("landed reply re-delivery skipped — reply event unreadable", undefined, {
				run: run.runId,
				conversation: run.conversationId,
				replySeq: run.replySeq,
			});
			continue;
		}
		try {
			for (const chunk of chunkWindows(text)) {
				await withTimeout(
					api.sendMessage(conv.chatId, chunk, {
						...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
					}),
					"sendMessage (landed reply re-delivery)",
				);
			}
		} catch (err) {
			log.error("landed reply re-delivery failed — stays pending", err, {
				run: run.runId,
				conversation: run.conversationId,
			});
			continue;
		}
		if (journal.markReplyDelivered(run.runId)) {
			delivered.add(run.runId);
			log.info("landed reply re-delivered", {
				run: run.runId,
				conversation: run.conversationId,
				chat: conv.chatId,
				replySeq: run.replySeq,
			});
		}
	}
	return delivered;
}
