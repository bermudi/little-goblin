import type { Api } from "grammy";
import { APP_ID_PREFIX } from "../conversation-address.ts";
import type { ConversationStore } from "../conversation.ts";
import { parseEvent } from "../conversation-events.ts";
import { log } from "../log.ts";
import type {
	InterruptedBootNotice,
	StrandedBootNotice,
	TurnJournal,
	TurnRun,
} from "../turn-journal.ts";
import { withTimeout } from "./deadline.ts";
import { chunkWindows } from "./delivery-text.ts";

// #579 — a boot notice is owed until a send lands, not until the next
// open: the claim runs only after at least one operator send resolved,
// so an all-failed boot (or one that died before attach) hands the row
// to the next boot instead of dropping it.
type NoticeClaims = Pick<TurnJournal, "markBootNoticeDelivered">;

const settleNotice = async (
	sends: Promise<unknown>[],
	claim: NoticeClaims,
	id: number,
	facts: Record<string, unknown>,
): Promise<void> => {
	const settled = await Promise.allSettled(sends);
	if (!settled.some((r) => r.status === "fulfilled")) return;
	// A claim racing shutdown (the db closing under a detached send)
	// stays owed — the next boot re-sends, at-least-once by design —
	// but loudly: the send DID land.
	try {
		if (claim.markBootNoticeDelivered(id)) {
			log.info("boot notice delivered", { notice: id, ...facts });
		}
	} catch (err) {
		log.error("boot notice claim failed — stays owed", err, { notice: id, ...facts });
	}
};

export function sendInterruptedTurnNotices(
	api: Api,
	notices: readonly InterruptedBootNotice[],
	operators: readonly number[],
	titleFor: (conversationId: string) => string | undefined,
	claims: NoticeClaims,
): void {
	for (const { id, run } of notices) {
		// The outbox is durable, so a row can outlive its advice: a run
		// that finished after the crash (or whose landed reply was
		// re-delivered — #482 — the text, not a notice, is the debt),
		// owes no DM. Claim the row without sending.
		if (run.status !== "interrupted" || (run.replyLanded && run.delivery === "delivered")) {
			if (claims.markBootNoticeDelivered(id)) {
				log.info("interrupted turn notice dropped — no longer owed", {
					notice: id,
					run: run.runId,
					status: run.status,
					delivery: run.delivery,
				});
			}
			continue;
		}
		const text =
			`interrupted turn ${run.runId.slice(0, 8)} — ` +
			`${titleFor(run.conversationId) ?? run.conversationId}, started ${new Date(run.startedMs).toISOString()}: ` +
			`${run.calls.completed} completed, ${run.calls.dispatched} dispatched (ambiguous), ` +
			`${run.calls.resolved} resolved, ${run.calls.planned} planned tool call(s). ` +
			`The process stopped mid-turn and the turn was not replayed — send a message in that ` +
			`conversation to continue; tool effects may already have happened, check before retrying.`;
		void settleNotice(
			operators.map((chat) =>
				(async () => {
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
						throw err;
					}
				})(),
			),
			claims,
			id,
			{ kind: "interrupted", run: run.runId, conversation: run.conversationId },
		);
	}
}

// #481 — accepted user input the dead process fenced before any turn
// admitted it: one line per conversation, separate from the per-run
// interrupted notices (those describe turns that DID run). Notice
// only — a new message remains the operator's move.
export function sendStrandedInputNotices(
	api: Api,
	notices: readonly StrandedBootNotice[],
	operators: readonly number[],
	titleFor: (conversationId: string) => string | undefined,
	claims: NoticeClaims,
): void {
	for (const { id, conversationId, count } of notices) {
		const how = conversationId.startsWith(APP_ID_PREFIX)
			? "open that conversation in the app to continue"
			: "send a message in that conversation to continue";
		const text =
			`${titleFor(conversationId) ?? conversationId}: ` +
			`${count} message(s) you sent before the restart weren't answered — ${how}`;
		void settleNotice(
			operators.map((chat) =>
				(async () => {
					try {
						await withTimeout(api.sendMessage(chat, text), "sendMessage (stranded input notice)");
						log.info("stranded input notice sent", {
							conversation: conversationId,
							chat,
							stranded: count,
						});
					} catch (err) {
						log.error("stranded input notice send failed", err, {
							conversation: conversationId,
							chat,
							stranded: count,
						});
						throw err;
					}
				})(),
			),
			claims,
			id,
			{ kind: "stranded", conversation: conversationId, stranded: count },
		);
	}
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
