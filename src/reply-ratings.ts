// 👍/👎 records: record-only by design — nothing reads them into the
// model, history, FTS, or memory. A vote change is a new row; reads are
// latest-wins per stamped reply. Telegram rows keep chat/message identity;
// app rows key the durable assistant event seq.

import type { Database } from "bun:sqlite";
import { z } from "zod";

export type ReplyRating = "up" | "down";
export type ReplyRatingChannel = "telegram" | "app";

export interface ReplyRatingRecord {
	channel: ReplyRatingChannel;
	conversationId: string;
	// The reply's causal anchor — the seq of the user event its turn
	// anchored to; joins a rating back to the exchange in events. Null
	// when the landed reply had no user anchor.
	anchorSeq: number | null;
	// Telegram delivery identity. App rows carry zeroes in the legacy
	// NOT NULL columns and use eventSeq instead.
	chatId: number;
	messageId: number;
	// The app reply's durable event seq.
	eventSeq: number | null;
	rating: ReplyRating;
	createdAt: string;
}

export type ReplyRatingWrite = Pick<
	ReplyRatingRecord,
	"conversationId" | "anchorSeq" | "chatId" | "messageId" | "rating"
>;

export type AppReplyRatingWrite = Pick<
	ReplyRatingRecord,
	"conversationId" | "anchorSeq" | "eventSeq" | "rating"
>;

export interface ReplyRatings {
	record(entry: ReplyRatingWrite): void;
	recordApp(entry: AppReplyRatingWrite): void;
	// Newest vote on a stamped Telegram message — null when never rated.
	latest(chatId: number, messageId: number): ReplyRatingRecord | null;
	// Newest vote on a durable app assistant event.
	latestEvent(conversationId: string, eventSeq: number): ReplyRatingRecord | null;
	// Latest vote per app event, in event order.
	listApp(conversationId: string): ReplyRatingRecord[];
}

const rowSchema = z.object({
	channel: z.enum(["telegram", "app"]),
	conversation_id: z.string(),
	anchor_seq: z.number().int().nullable(),
	chat_id: z.number(),
	message_id: z.number(),
	event_seq: z.number().int().nullable(),
	rating: z.enum(["up", "down"]),
	created_at: z.string(),
});

type RatingRow = z.infer<typeof rowSchema>;

const recordOf = (r: RatingRow): ReplyRatingRecord => ({
	channel: r.channel,
	conversationId: r.conversation_id,
	anchorSeq: r.anchor_seq,
	chatId: r.chat_id,
	messageId: r.message_id,
	eventSeq: r.event_seq,
	rating: r.rating,
	createdAt: r.created_at,
});

// The table is created by openStore, which owns the schema.
export function openRatings(db: Database): ReplyRatings {
	const qRecord = db.query(
		"INSERT INTO reply_ratings (channel, conversation_id, anchor_seq, chat_id, message_id, event_seq, rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const qLatest = db.query<RatingRow, [number, number]>(
		"SELECT channel, conversation_id, anchor_seq, chat_id, message_id, event_seq, rating, created_at FROM reply_ratings WHERE channel = 'telegram' AND chat_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1",
	);
	const qLatestEvent = db.query<RatingRow, [string, number]>(
		"SELECT channel, conversation_id, anchor_seq, chat_id, message_id, event_seq, rating, created_at FROM reply_ratings WHERE channel = 'app' AND conversation_id = ? AND event_seq = ? ORDER BY id DESC LIMIT 1",
	);
	const qListApp = db.query<RatingRow, [string]>(
		"SELECT channel, conversation_id, anchor_seq, chat_id, message_id, event_seq, rating, created_at FROM reply_ratings WHERE channel = 'app' AND conversation_id = ? ORDER BY id",
	);
	return {
		record(entry) {
			qRecord.run(
				"telegram",
				entry.conversationId,
				entry.anchorSeq,
				entry.chatId,
				entry.messageId,
				null,
				entry.rating,
				new Date().toISOString(),
			);
		},
		recordApp(entry) {
			qRecord.run(
				"app",
				entry.conversationId,
				entry.anchorSeq,
				0,
				0,
				entry.eventSeq,
				entry.rating,
				new Date().toISOString(),
			);
		},
		latest(chatId, messageId) {
			const row = qLatest.get(chatId, messageId);
			return row === null ? null : recordOf(rowSchema.parse(row));
		},
		latestEvent(conversationId, eventSeq) {
			const row = qLatestEvent.get(conversationId, eventSeq);
			return row === null ? null : recordOf(rowSchema.parse(row));
		},
		listApp(conversationId) {
			const latest = new Map<number, ReplyRatingRecord>();
			for (const row of qListApp.all(conversationId)) {
				const record = recordOf(rowSchema.parse(row));
				if (record.eventSeq !== null) latest.set(record.eventSeq, record);
			}
			return [...latest.values()].sort((a, b) => (a.eventSeq ?? 0) - (b.eventSeq ?? 0));
		},
	};
}
