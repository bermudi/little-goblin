// The ping→conversation map (design/app.md → Spin-off → Telegram
// rings): a swipe-reply to a delegation ping routes into the app
// conversation that rang. The mapping rides goblin.sqlite — the same
// shared handle the inbox owns — so a reply after a restart still
// routes. Keyed by (chat, message): Telegram message ids are only
// unique per chat.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "../log.ts";

export interface PingStore {
	/** A delivered ping → the app conversation that produced it.
	 *  Also the sweep point: rows whose conversation no longer exists
	 *  are garbage (a swipe-reply to them falls through to ordinary
	 *  routing) and are deleted here — opportunistically, on the rare
	 *  write path, never on intake's hot lookup. */
	record(chatId: number, messageId: number, conversationId: string): void;
	/** The app conversation a ping belongs to — null = not a ping. */
	lookup(chatId: number, messageId: number): string | null;
}

const rowSchema = z.object({ conversation_id: z.string() });

export function openPings(db: Database): PingStore {
	db.run(`CREATE TABLE IF NOT EXISTS tg_pings (
		chat_id INTEGER NOT NULL,
		message_id INTEGER NOT NULL,
		conversation_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (chat_id, message_id)
	)`);
	const qRecord = db.query(
		"INSERT INTO tg_pings (chat_id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)",
	);
	const qLookup = db.query<{ conversation_id: string }, [number, number]>(
		"SELECT conversation_id FROM tg_pings WHERE chat_id = ? AND message_id = ?",
	);
	// The map rides the store's own handle, so the conversations table
	// is right there — rows outliving their conversation are deleted on
	// the next record. This is the table's only GC (#110): what it bounds
	// is the operator's conversation retention, and a hand given to
	// openPings without that table fails loud on first record.
	const qSweep = db.query(
		"DELETE FROM tg_pings WHERE conversation_id NOT IN (SELECT id FROM conversations)",
	);
	return {
		record(chatId, messageId, conversationId) {
			qRecord.run(chatId, messageId, conversationId, new Date().toISOString());
			// After the insert — the fresh row's conversation exists by
			// construction, so the sweep can never take it.
			const swept = qSweep.run().changes;
			if (swept > 0) log.info("ping map swept — conversations gone", { swept });
		},
		lookup(chatId, messageId) {
			const row = qLookup.get(chatId, messageId);
			return row === null ? null : rowSchema.parse(row).conversation_id;
		},
	};
}
