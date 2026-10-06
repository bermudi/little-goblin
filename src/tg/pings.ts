// The ping→conversation map (design/app.md → Spin-off → Telegram
// rings): a swipe-reply to a delegation ping routes into the app
// conversation that rang. The mapping rides goblin.sqlite — the same
// shared handle the inbox owns — so a reply after a restart still
// routes. Keyed by (chat, message): Telegram message ids are only
// unique per chat.

import type { Database } from "bun:sqlite";
import { z } from "zod";

export interface PingStore {
	/** A delivered ping → the app conversation that produced it. */
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
	return {
		record(chatId, messageId, conversationId) {
			qRecord.run(chatId, messageId, conversationId, new Date().toISOString());
		},
		lookup(chatId, messageId) {
			const row = qLookup.get(chatId, messageId);
			return row === null ? null : rowSchema.parse(row).conversation_id;
		},
	};
}
