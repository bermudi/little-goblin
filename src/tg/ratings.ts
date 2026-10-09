// The 👍/👎 tap record: append-only rows on the shared store handle, so
// a tap after a restart still lands. Record-only by design — nothing
// reads these into the model, history, FTS, or memory. A vote change is
// a new row; reads are latest-wins per stamped message.

import type { Database } from "bun:sqlite";
import { z } from "zod";

export type ReplyRating = "up" | "down";

export interface ReplyRatingRecord {
	conversationId: string;
	// The reply's anchor — the seq of the user event its turn anchored
	// to; joins a rating back to the exchange in events. Null when the
	// landed reply had no user anchor.
	anchorSeq: number | null;
	chatId: number;
	messageId: number;
	rating: ReplyRating;
	createdAt: string;
}

export type ReplyRatingWrite = Omit<ReplyRatingRecord, "createdAt">;

export interface ReplyRatings {
	record(entry: ReplyRatingWrite): void;
	// Newest vote on a stamped message — null when never rated.
	latest(chatId: number, messageId: number): ReplyRatingRecord | null;
}

const rowSchema = z.object({
	conversation_id: z.string(),
	anchor_seq: z.number().int().nullable(),
	chat_id: z.number(),
	message_id: z.number(),
	rating: z.enum(["up", "down"]),
	created_at: z.string(),
});

// The table is created by openStore, which owns the schema.
export function openRatings(db: Database): ReplyRatings {
	const qRecord = db.query(
		"INSERT INTO reply_ratings (conversation_id, anchor_seq, chat_id, message_id, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const qLatest = db.query<
		{
			conversation_id: string;
			anchor_seq: number | null;
			chat_id: number;
			message_id: number;
			rating: string;
			created_at: string;
		},
		[number, number]
	>(
		"SELECT conversation_id, anchor_seq, chat_id, message_id, rating, created_at FROM reply_ratings WHERE chat_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1",
	);
	return {
		record(entry) {
			qRecord.run(
				entry.conversationId,
				entry.anchorSeq,
				entry.chatId,
				entry.messageId,
				entry.rating,
				new Date().toISOString(),
			);
		},
		latest(chatId, messageId) {
			const row = qLatest.get(chatId, messageId);
			if (row === null) return null;
			const r = rowSchema.parse(row);
			return {
				conversationId: r.conversation_id,
				anchorSeq: r.anchor_seq,
				chatId: r.chat_id,
				messageId: r.message_id,
				rating: r.rating,
				createdAt: r.created_at,
			};
		},
	};
}
