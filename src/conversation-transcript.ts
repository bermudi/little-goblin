// The transcript writes: append (eligibility stamp, memory enqueue,
// unarchive) and editUserMessage (the rewind sweep). Pure move from
// conversation.ts — openStore spreads these; the message-id seam into
// the history view and the epoch bump arrive as deps.

import type { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { log } from "./log.ts";
import { stampArrival } from "./message-context.ts";
import type { MemoryDocument } from "./memory/hindsight.ts";
import type { MemoryQueue } from "./memory/queue.ts";
import type { ConversationQueries } from "./conversation-queries.ts";

// The observable shape of an edit's sweep: the cut is the edited event's
// seq, seq is the new event's (never-reused) position, and the counts
// name every dependent the delete removed.
export interface MessageEdit {
	seq: number;
	cutSeq: number;
	events: number;
	compactions: number;
	contexts: number;
	projections: number;
	ratings: number;
}

export function makeConversationTranscript(
	db: Database,
	queries: Pick<
		ConversationQueries,
		| "qGet"
		| "qNextSeq"
		| "qInsertEvent"
		| "qRaiseSeqHighwater"
		| "qRewindProjections"
		| "qRewindEvents"
		| "qRewindCompactions"
		| "qRewindContexts"
		| "qRewindRatings"
		| "qDeleteWindows"
		| "qDeleteClaudeSessions"
	>,
	deps: {
		memoryQueue: MemoryQueue;
		bump: (id: string, previousEpoch?: number) => number;
		// The history view's message-id seam: resolve a durable event by
		// its client message id before the rewind decides its fate.
		messageEvent: (id: string, messageId: string) => { seq: number; role: string } | null;
	},
) {
	const {
		qGet,
		qNextSeq,
		qInsertEvent,
		qRaiseSeqHighwater,
		qRewindProjections,
		qRewindEvents,
		qRewindCompactions,
		qRewindContexts,
		qRewindRatings,
		qDeleteWindows,
		qDeleteClaudeSessions,
	} = queries;
	const { memoryQueue, bump, messageEvent } = deps;

	function editUserMessage(id: string, messageId: string, message: UIMessage): MessageEdit | null {
		let unarchived = false;
		const edit = db.transaction((): MessageEdit | null => {
			const found = messageEvent(id, messageId);
			if (found === null || found.role !== "user") return null;
			const conv = qGet.get(id);
			if (!conv) throw new Error(`conversation ${id} not found`);
			const cut = found.seq;
			// Spend every seq this conversation ever wrote before the
			// delete: a rating or journal row addressed past the cut must
			// never re-bind to the event the edit appends.
			qRaiseSeqHighwater.run(id);
			// The projection sweep reads the events it matches — it runs
			// before the event delete empties them.
			const projections = Number(qRewindProjections.run(id, cut).changes);
			const events = Number(qRewindEvents.run(id, cut).changes);
			const compactions = Number(qRewindCompactions.run(id, cut).changes);
			const contexts = Number(qRewindContexts.run(id, cut).changes);
			const ratings = Number(qRewindRatings.run(id, cut).changes);
			const seq = (qNextSeq.get(id)?.n ?? 0) + 1;
			stampArrival(id, message, new Date());
			qInsertEvent.run(
				id,
				seq,
				message.role,
				JSON.stringify({ v: 1, message }),
				null,
				new Date().toISOString(),
				conv.memory_excluded === 0 ? 1 : 0,
			);
			// The rewind retires every pre-edit admission's authority: a
			// claimed-but-unlinked wake (crash/backoff window) carries a
			// `history_seq` that the delete just killed, and reconcile resubmits
			// such claims only while the claim epoch still matches — the
			// bump fails them closed, never resubmitting a dead seq.
			// Pending wakes are untouched: their delivery is still owed
			// and lands at the new tail under the new epoch; linked wakes
			// keep their run-chain settlement (the edit route abandons
			// interrupted runs the cut orphans).
			bump(id);
			// The captured outbound prompt is verbatim pre-edit content —
			// the window view must not serve it after the rewind. Same
			// sweep deleteConversation runs; the next turn's capture
			// rewrites the row. The native session records go too: the
			// SDK transcript still holds the retracted content.
			qDeleteWindows.run(id);
			qDeleteClaudeSessions.run(id);
			if (
				conv.archived_at !== null &&
				db.run("UPDATE conversations SET archived_at = NULL WHERE id = ?", [id]).changes > 0
			) {
				unarchived = true;
			}
			return { seq, cutSeq: cut, events, compactions, contexts, projections, ratings };
		})();
		if (edit === null) return null;
		// Queued retention follows the events out. The purge waits for
		// the commit — cancelling first and then rolling back would
		// strand rows forever — and an already-retained memory is out of
		// scope: the service owns it, this store can only stop new work.
		try {
			const purged = memoryQueue.cancelAnchoredFrom(id, edit.cutSeq);
			if (purged > 0) {
				log.info("retention purged with edited tail", {
					conversation: id,
					documents: purged,
				});
			}
		} catch (err) {
			log.warn("retention purge failed during message edit", err, { conversation: id });
		}
		if (unarchived) log.info("conversation unarchived on activity", { conversation: id });
		return edit;
	}

	function append(
		id: string,
		messages: UIMessage[],
		opts?: {
			anchorSeq?: number | null;
			memory?: { target: string; document: MemoryDocument };
			// Force the ineligible stamp even when the live flag is on:
			// a reply that derived from an excluded-era input stays out
			// of every memory-bound projection, same as excluded-era
			// events themselves.
			exclude?: boolean;
		},
	): number[] {
		let operation: string | undefined;
		let unarchived = false;
		const seqs = db.transaction(() => {
			const start = qNextSeq.get(id)?.n ?? 0;
			const now = new Date().toISOString();
			// Eligibility is stamped at admission, from the live exclusion
			// flag — the one moment the answer is knowable. Everything
			// later (including a /memory on) reads this stamp, never the
			// flag: history is not rewritten and exclusion is not retroactive.
			const conv = qGet.get(id);
			if (!conv) throw new Error(`conversation ${id} not found`);
			const eligible = conv.memory_excluded === 0 && opts?.exclude !== true ? 1 : 0;
			// Activity resurrects an archived app conversation — an
			// event (delegation notice, operator send) returns it to the
			// rail rather than accumulating replies unseen.
			if (
				conv.archived_at !== null &&
				db.run("UPDATE conversations SET archived_at = NULL WHERE id = ?", [id]).changes > 0
			) {
				unarchived = true;
			}
			for (const [i, m] of messages.entries()) {
				stampArrival(id, m, new Date(now));
				qInsertEvent.run(
					id,
					start + i + 1,
					m.role,
					JSON.stringify({ v: 1, message: m }),
					opts?.anchorSeq ?? null,
					now,
					eligible,
				);
			}
			// The retention gate rides the same transaction as the stamp: an
			// exclusion committed anywhere before this append drops the
			// enqueue here even when the caller computed its option earlier.
			if (opts?.memory && eligible === 1) {
				if (
					opts.memory.document.conversationId !== id ||
					!messages.some(
						(message) =>
							message.role === "assistant" &&
							opts.memory!.document.sourceIds.includes(message.id),
					)
				) {
					throw new Error("Memory retention must accompany its completed assistant event");
				}
				operation = memoryQueue.enqueue(opts.memory.target, opts.memory.document);
			}
			return messages.map((_, i) => start + i + 1);
		})();
		if (operation)
			log.info("memory queued", {
				conversation: id,
				operation,
				document: opts?.memory?.document.id,
			});
		if (opts?.memory && operation === undefined) {
			log.info("memory retention dropped — conversation excluded at write", {
				conversation: id,
				document: opts.memory.document.id,
			});
		}
		if (unarchived) {
			log.info("conversation unarchived on activity", { conversation: id });
		}
		return seqs;
	}

	return { append, editUserMessage };
}
