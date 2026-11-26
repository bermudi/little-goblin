// Conversation deletion: the designed anchor refusal (advisory answer
// and typed throw share one text) and the cascade that drops a
// conversation and everything it owns. Pure move from conversation.ts —
// openStore spreads these.

import type { Database } from "bun:sqlite";
import { log } from "./log.ts";
import type { MemoryQueue } from "./memory/queue.ts";
import type { ConversationQueries } from "./conversation-queries.ts";
import { sweepConversationWakes } from "./wake-store.ts";

export class DeleteRefused extends Error {}

const deleteRefusalText = (id: string, anchors: { responsibilityId: string; status: string }[]): string =>
	`conversation ${id} anchors retired responsibilities ${anchors
		.map((a) => `${a.responsibilityId} (${a.status})`)
		.join(", ")} — their rows stay on disk; drop them before deleting`;

function legacyAnchors(db: Database, id: string): { responsibilityId: string; status: string }[] {
	const table = db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'responsibilities'")
		.get();
	if (table === null) return [];
	return db
		.query<{ responsibility_id: string; status: string }, [string]>(
			"SELECT responsibility_id, status FROM responsibilities WHERE coordination_conversation_id = ? ORDER BY created_at",
		)
		.all(id)
		.map((r) => ({ responsibilityId: r.responsibility_id, status: r.status }));
}

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

	function deleteRefusal(id: string): string | null {
		const anchors = legacyAnchors(db, id);
		return anchors.length > 0 ? deleteRefusalText(id, anchors) : null;
	}

	function deleteConversation(id: string): void {
		const swept = db.transaction((): { wakes: number; workEvents: number; watches: number; asks: number } => {
			const anchors = legacyAnchors(db, id);
			if (anchors.length > 0) throw new DeleteRefused(deleteRefusalText(id, anchors));
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
			db.run("DELETE FROM app_rolls WHERE conversation_id = ?", [id]);
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
			const watches = db.query("DELETE FROM watches WHERE conversation_id = ?").run(id).changes;
			const asks = db.query("DELETE FROM asks WHERE conversation_id = ?").run(id).changes;
			qDeleteEvents.run(id);
			qDeleteCompactions.run(id);
			qDeleteContexts.run(id);
			// The captured window has no FK — it rides the sweep so a
			// re-minted id never inherits the last generation's prompt.
			// Same for the native session records (#418).
			qDeleteWindows.run(id);
			qDeleteClaudeSessions.run(id);
			qDeleteConv.run(id);
			return { ...counts, watches, asks };
		})();
		if (swept.wakes > 0) {
			log.info("wake rows swept with conversation", {
				conversation: id,
				wakes: swept.wakes,
				workEvents: swept.workEvents,
			});
		}
		if (swept.watches > 0) {
			log.info("watch rows swept with conversation", { conversation: id, watches: swept.watches });
		}
		if (swept.asks > 0) {
			log.info("ask rows swept with conversation", { conversation: id, asks: swept.asks });
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
