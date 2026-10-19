import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "../log.ts";

export interface PingStore {
	record(chatId: number, messageId: number, conversationId: string): void;
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
	const qSweep = db.query(
		"DELETE FROM tg_pings WHERE conversation_id NOT IN (SELECT id FROM conversations)",
	);
	return {
		record(chatId, messageId, conversationId) {
			qRecord.run(chatId, messageId, conversationId, new Date().toISOString());
			const swept = qSweep.run().changes;
			if (swept > 0) log.info("ping map swept — conversations gone", { swept });
		},
		lookup(chatId, messageId) {
			const row = qLookup.get(chatId, messageId);
			return row === null ? null : rowSchema.parse(row).conversation_id;
		},
	};
}
