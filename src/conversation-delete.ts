// Conversation deletion: the designed anchor refusal (advisory answer
// and typed throw share one text) and the cascade that drops a
// conversation and everything it owns. Pure move from conversation.ts —
// openStore spreads these.

import type { Database } from "bun:sqlite";
import { log } from "./log.ts";
import type { MemoryQueue } from "./memory/queue.ts";
import type { ConversationQueries } from "./conversation-queries.ts";
import { sweepConversationWakes } from "./wake-store.ts";

// coordinationAnchors arrives as a dep, not an import: responsibilities
// sits inside the frozen import-cycle cluster, and importing it would
// pull this module in (import-cycles.test.ts).
type CoordinationAnchors = (
	db: Database,
	id: string,
) => { responsibilityId: string; status: string }[];

// deleteConversation's designed refusal (coordination anchors), typed so
// a boundary can tell it from a real failure — the app's DELETE route
// must answer it, not 500 it.
export class DeleteRefused extends Error {}

// One text for both surfaces: deleteRefusal's advisory answer and
// deleteConversation's throw must never drift apart.
const deleteRefusalText = (
	id: string,
	anchors: { responsibilityId: string; status: string }[],
): string =>
	`conversation ${id} coordinates ${anchors
		.map((a) => `${a.responsibilityId} (${a.status})`)
		.join(", ")} — resolve them before deleting`;

export function makeConversationDelete(
	db: Database,
	queries: Pick<
		ConversationQueries,
		| "qGet"
		| "qDeleteEvents"
		| "qDeleteCompactions"
		| "qDeleteContexts"
		| "qDeleteWindows"
		| "qDeleteClaudeSessions"
		| "qDeleteConv"
	>,
	memoryQueue: MemoryQueue,
	coordinationAnchors: CoordinationAnchors,
) {
	const {
		qGet,
		qDeleteEvents,
		qDeleteCompactions,
		qDeleteContexts,
		qDeleteWindows,
		qDeleteClaudeSessions,
		qDeleteConv,
	} = queries;

	// The refusal deleteConversation would raise right now, as the message
	// the caller should show — null when the delete would proceed.
	// Advisory, not a fence: an anchor minted after this answer (a live
	// turn taking a responsibility) still refuses inside deleteConversation.
	function deleteRefusal(id: string): string | null {
		const anchors = coordinationAnchors(db, id);
		return anchors.length > 0 ? deleteRefusalText(id, anchors) : null;
	}

	function deleteConversation(id: string): void {
		const swept = db.transaction((): { wakes: number; workEvents: number } => {
			// A coordination surface must not outlive the responsibility
			// that stands on it: the handover loop and wake delivery
			// would both dangle. Terminal responsibilities keep their
			// records — the conversation stays too. Refuse with names,
			// not the bare FK error the row delete would raise.
			const anchors = coordinationAnchors(db, id);
			if (anchors.length > 0) {
				throw new DeleteRefused(deleteRefusalText(id, anchors));
			}
			// Sever the rolling navigation chain first — successors'
			// previous_dm_id would FK-fail the row delete (a demoted
			// lane's persona reset is the one caller that deletes a
			// rolled conversation; /back must not reach it anyway).
			db.run("UPDATE conversations SET previous_dm_id = NULL WHERE previous_dm_id = ?", [id]);
			// Preserve the lane's rolling ordinal high-water before
			// dropping the FK-enforced dm_rolls row, so a demoted lane
			// re-mints a fresh id instead of colliding with (or reusing)
			// the deleted conversation.
			db.run(
				`INSERT INTO dm_roll_highwater (chat_id, n)
				SELECT chat_id, n FROM dm_rolls WHERE current_id = ?
				ON CONFLICT(chat_id) DO UPDATE SET
					n = MAX(dm_roll_highwater.n, excluded.n)`,
				[id],
			);
			// The lane pointer is NOT NULL — dropping the deleted row's
			// dm_rolls entry is the sever; the high-water survives in
			// dm_roll_highwater and rollDm re-mints the lane (the reset
			// flow calls it immediately).
			db.run("DELETE FROM dm_rolls WHERE current_id = ?", [id]);
			// Record the final epoch before the row goes — a recreated id
			// must not collide with a token this generation issued.
			const gone = qGet.get(id);
			if (gone !== null) {
				db.run(
					`INSERT INTO conversation_epoch_hwm (conversation_id, epoch) VALUES (?, ?)
					 ON CONFLICT(conversation_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)`,
					[gone.id, gone.epoch],
				);
			}
			// Wake rows are this conversation's delivery bookkeeping —
			// they ride the delete, in the same transaction.
			const counts = sweepConversationWakes(db, id);
			qDeleteEvents.run(id);
			qDeleteCompactions.run(id);
			qDeleteContexts.run(id);
			// The captured window has no FK — it rides the sweep so a
			// re-minted id never inherits the last generation's prompt.
			// Same for the native session records (#418).
			qDeleteWindows.run(id);
			qDeleteClaudeSessions.run(id);
			qDeleteConv.run(id);
			return counts;
		})();
		if (swept.wakes > 0) {
			log.info("wake rows swept with conversation", {
				conversation: id,
				wakes: swept.wakes,
				workEvents: swept.workEvents,
			});
		}
		// The purge waits for the commit: queued retention rides the
		// append transaction only, so cancelling before the delete and
		// then rolling back would strand those rows forever. A purge
		// failure is still a warn — a corrupt payload must not bar the
		// delete that already landed.
		try {
			memoryQueue.cancelConversation(id);
		} catch (err) {
			log.warn("retention purge failed during conversation delete", err, {
				conversation: id,
			});
		}
	}

	return { deleteRefusal, deleteConversation };
}
