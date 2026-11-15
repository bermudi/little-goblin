// Rolling private-DM navigation: minting the next lane (rollDm),
// stepping back to the predecessor (backDm/previousDm), and the
// current-lane read. Pure move from conversation.ts — openStore
// spreads these; the lane's ordinal high-water rules live with the
// mint.

import type { Database } from "bun:sqlite";
import {
	formatAddress,
	privateChatIdSchema,
	rollingDmOrdinal,
} from "./conversation-address.ts";
import type { ConversationQueries, Row } from "./conversation-queries.ts";

// toConversation arrives as a dep, not an import: conversation-read sits
// inside the frozen import-cycle cluster, and importing it — even as a
// type — would pull this module in (import-cycles.test.ts). The factory
// is generic over the mapped shape for the same reason.
export function makeConversationRolling<TConversation>(
	db: Database,
	queries: Pick<
		ConversationQueries,
		| "qDmRoll"
		| "qDmOrdinalCandidates"
		| "qDmRollHighwater"
		| "qUpsertRoll"
		| "qSelectPrevious"
		| "qGet"
		| "qInsertConv"
	>,
	toConversation: (r: Row) => TConversation,
) {
	const { qDmRoll, qDmOrdinalCandidates, qDmRollHighwater, qUpsertRoll, qSelectPrevious, qGet, qInsertConv } =
		queries;

	function previousDmRow(chatId: number): Row | null {
		if (!privateChatIdSchema.safeParse(chatId).success) return null;
		const roll = qDmRoll.get(chatId);
		if (!roll) return null;
		const current = qGet.get(roll.current_id);
		if (!current || current.previous_dm_id === null) return null;
		const currentOrdinal = rollingDmOrdinal(current, chatId);
		if (currentOrdinal === null) return null;
		const previous = qGet.get(current.previous_dm_id);
		if (!previous || previous.id === current.id) return null;
		const previousOrdinal = rollingDmOrdinal(previous, chatId);
		// Every back step must decrease the creation ordinal, including
		// branch source links. A corrupt forward link can otherwise cycle.
		return previousOrdinal !== null && previousOrdinal < currentOrdinal ? previous : null;
	}

	function currentDm(chatId: number) {
		const roll = qDmRoll.get(chatId);
		if (!roll) return null;
		const row = qGet.get(roll.current_id);
		return row ? toConversation(row) : null;
	}

	function rollDm(chatId: number, defaultCwd: string) {
		privateChatIdSchema.parse(chatId);
		return db.transaction(() => {
			const roll = qDmRoll.get(chatId);
			const highwater = qDmRollHighwater.get(chatId);
			let n = Math.max(roll?.n ?? 0, highwater?.n ?? 0) + 1;
			if (!roll) {
				// The lane pointer was severed (its current row deleted)
				// and the stored n went with it — recover the mark from
				// extant rows and the delete tombstones too:
				// dm_roll_highwater only knows what post-upgrade writes
				// told it, and a re-minted ordinal would collide with
				// outstanding epoch tokens and silently reconnect a
				// demoted lane.
				for (const { id: candidate } of qDmOrdinalCandidates.all(chatId, String(chatId))) {
					const ordinal = rollingDmOrdinal(
						{ id: candidate, chat_id: chatId, thread_id: null },
						chatId,
					);
					if (ordinal !== null && ordinal + 1 > n) n = ordinal + 1;
				}
			}
			const id = formatAddress({ kind: "rolling", chatId, ordinal: n });
			const now = new Date().toISOString();
			const source = roll ? qGet.get(roll.current_id) : null;
			qInsertConv.run(id, chatId, null, defaultCwd, now);
			db.run("UPDATE conversations SET previous_dm_id = ? WHERE id = ?", [
				source && rollingDmOrdinal(source, chatId) !== null ? source.id : null,
				id,
			]);
			qUpsertRoll.run(chatId, id, n, now);
			db.run(
				"INSERT INTO dm_roll_highwater (chat_id, n) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET n = excluded.n",
				[chatId, n],
			);
			const created = qGet.get(id);
			if (!created) throw new Error(`conversation ${id} insert failed`);
			return toConversation(created);
		})();
	}

	function previousDm(chatId: number) {
		const row = previousDmRow(chatId);
		return row ? toConversation(row) : null;
	}

	function backDm(chatId: number) {
		return db.transaction(() => {
			const row = previousDmRow(chatId);
			if (!row) return null;
			qSelectPrevious.run(row.id, new Date().toISOString(), chatId);
			return toConversation(row);
		})();
	}

	return { currentDm, rollDm, previousDm, backDm };
}
