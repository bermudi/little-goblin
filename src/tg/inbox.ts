// Durable Telegram intake buffer. Shares the conversation store's SQLite handle
// so a history append and its inbox acknowledgement commit together.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "../log.ts";
import type { IncomingMedia } from "./media.ts";

const idSchema = z.number().int().safe();
const mediaSchema = z.strictObject({
	fileId: z.string().min(1),
	fileUniqueId: z.string().min(1),
	fileName: z.string(),
	mimeType: z.string().min(1),
	transcribable: z.boolean().optional(),
}).transform(({ transcribable, ...rest }): IncomingMedia =>
	transcribable === undefined ? rest : { ...rest, transcribable });

export function validatedInboxMedia(media: unknown): IncomingMedia {
	return mediaSchema.parse(media);
}
const payloadSchema = z.strictObject({
	conversationId: z.string().min(1),
	chatId: idSchema,
	messageId: idSchema,
	text: z.string(),
	media: mediaSchema.nullable(),
	mediaError: z.string().nullable(),
});

export interface InboxPayload {
	conversationId: string;
	chatId: number;
	messageId: number;
	text: string;
	media: IncomingMedia | null;
	mediaError: string | null;
}
export interface InboxEntry { updateId: number; payload: InboxPayload }

const rowSchema = z.object({
	update_id: idSchema,
	chat_id: idSchema,
	message_id: idSchema,
	conversation_id: z.string().min(1),
	payload_json: z.string().nullable(),
	committed_at: z.string().nullable(),
});

function decode(row: unknown): InboxEntry {
	const r = rowSchema.parse(row);
	if (r.committed_at !== null || r.payload_json === null) {
		throw new Error(`Telegram inbox update ${r.update_id} is not pending`);
	}
	let json: unknown;
	try {
		json = JSON.parse(r.payload_json);
	} catch (err) {
		throw new Error(`Invalid Telegram inbox JSON for update ${r.update_id}`, { cause: err });
	}
	const parsed = payloadSchema.safeParse(json);
	if (!parsed.success || parsed.data.conversationId !== r.conversation_id ||
		parsed.data.chatId !== r.chat_id || parsed.data.messageId !== r.message_id) {
		throw new Error(`Invalid Telegram inbox payload for update ${r.update_id}`);
	}
	return { updateId: r.update_id, payload: parsed.data };
}

export function openTelegramInbox(db: Database): {
	record(updateId: number, payload: InboxPayload): boolean;
	pending(): InboxEntry[];
	commitBatch(updateIds: number[], conversationId: string, append: () => void): void;
} {
	db.run(`CREATE TABLE IF NOT EXISTS tg_inbox (
		update_id INTEGER PRIMARY KEY,
		chat_id INTEGER NOT NULL,
		message_id INTEGER NOT NULL,
		conversation_id TEXT NOT NULL,
		payload_json TEXT,
		committed_at TEXT,
		UNIQUE(chat_id, message_id),
		CHECK ((committed_at IS NULL AND payload_json IS NOT NULL) OR
		       (committed_at IS NOT NULL AND payload_json IS NULL))
	)`);
	const insert = db.query(`INSERT INTO tg_inbox
		(update_id, chat_id, message_id, conversation_id, payload_json)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
	const selectPending = db.query(`SELECT update_id, chat_id, message_id, conversation_id, payload_json, committed_at
		FROM tg_inbox WHERE committed_at IS NULL ORDER BY update_id`);
	const selectOne = db.query(`SELECT update_id, chat_id, message_id, conversation_id, payload_json, committed_at
		FROM tg_inbox WHERE update_id = ?`);
	const selectMessage = db.query(`SELECT update_id, chat_id, message_id, conversation_id, payload_json, committed_at
		FROM tg_inbox WHERE chat_id = ? AND message_id = ?`);
	const commit = db.query(`UPDATE tg_inbox SET committed_at = ?, payload_json = NULL
		WHERE update_id = ? AND committed_at IS NULL`);

	return {
		record(updateId, payload) {
			const fields = { updateId, conversationId: payload.conversationId, chatId: payload.chatId, messageId: payload.messageId };
			try {
				idSchema.parse(updateId);
				const valid = payloadSchema.parse(payload);
				const inserted = insert.run(updateId, valid.chatId, valid.messageId, valid.conversationId, JSON.stringify(valid)).changes === 1;
				if (!inserted) {
					// An update ID and a chat-scoped message ID both identify
					// one message. A conflict on either with a different
					// identity is corruption, not a harmless redelivery.
					const existing = rowSchema.parse(
						selectOne.get(updateId) ?? selectMessage.get(valid.chatId, valid.messageId),
					);
					if (existing.chat_id !== valid.chatId || existing.message_id !== valid.messageId ||
						existing.conversation_id !== valid.conversationId ||
						(existing.payload_json !== null && existing.payload_json !== JSON.stringify(valid))) {
						throw new Error(`Telegram inbox conflicting identity for update ${updateId}`);
					}
				}
				log.info(inserted ? "telegram inbox recorded" : "telegram inbox duplicate", fields);
				return inserted;
			} catch (err) {
				log.error("telegram inbox record failed", err, fields);
				throw err;
			}
		},
		pending() {
			try {
				return selectPending.all().map(decode);
			} catch (err) {
				log.error("telegram inbox pending read failed", err);
				throw err;
			}
		},
		commitBatch(updateIds, conversationId, append) {
			const fields = { updateIds, conversationId };
			try {
				if (updateIds.length === 0 || new Set(updateIds).size !== updateIds.length ||
					!updateIds.every((id) => idSchema.safeParse(id).success) ||
					!z.string().min(1).safeParse(conversationId).success) {
					throw new Error("Invalid Telegram inbox batch");
				}
				db.transaction(() => {
					for (const id of updateIds) {
						const row = selectOne.get(id);
						if (!row || decode(row).payload.conversationId !== conversationId) {
							throw new Error(`Telegram inbox update ${id} is missing, committed, or in another conversation`);
						}
					}
					append(); // ConversationStore.append opens a savepoint on this same handle.
					const now = new Date().toISOString();
					for (const id of updateIds) {
						if (commit.run(now, id).changes !== 1) throw new Error(`Telegram inbox update ${id} changed during commit`);
					}
				})();
				log.info("telegram inbox batch committed", fields);
			} catch (err) {
				log.error("telegram inbox batch failed — rolled back", err, fields);
				throw err;
			}
		},
	};
}
