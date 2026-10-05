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
	// Optional so rows journaled before the Rolling DM cutover still parse.
	quoted: z.strictObject({ messageId: idSchema, text: z.string() }).optional(),
});

export interface InboxPayload {
	conversationId: string;
	chatId: number;
	messageId: number;
	text: string;
	media: IncomingMedia | null;
	mediaError: string | null;
	// The message this one quoted (msg.reply_to_message): id + its own
	// text/caption, head-cut at intake into the leading parts line.
	quoted?: { messageId: number; text: string } | undefined;
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

const updateIdSchema = idSchema.nonnegative();
const dmLaneSchema = z.string().regex(/^dm:[1-9]\d*$/);
const rollingTargetSchema = z.string().regex(/^dm:[1-9]\d*:[1-9]\d*$/);

function archiveScope(laneKey: string, targetId?: string): number {
	dmLaneSchema.parse(laneKey);
	const chatId = idSchema.positive().parse(Number(laneKey.slice(3)));
	if (targetId !== undefined) {
		rollingTargetSchema.parse(targetId);
		const [kind, chat, ordinal] = targetId.split(":");
		if (kind !== "dm" || idSchema.positive().parse(Number(chat)) !== chatId ||
			!idSchema.positive().safeParse(Number(ordinal)).success) {
			throw new Error("Telegram inbox archive target is outside its DM lane");
		}
	}
	return chatId;
}

const assignmentSchema = z.object({ target_id: rollingTargetSchema });

export function openTelegramInbox(db: Database): {
	record(updateId: number, payload: InboxPayload): boolean;
	pending(): InboxEntry[];
	pendingIds(updateIds: readonly number[], laneKey: string): number[];
	archivePendingBefore(laneKey: string, beforeUpdateId: number, targetId: string): number;
	archivedTarget(updateId: number, laneKey: string): string | null;
	hasPendingBefore(laneKey: string, beforeUpdateId: number): boolean;
	assertRouteable(updateIds: number[], laneKey: string): boolean;
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
	// The original lane/payload is never rewritten: redelivery must still
	// match its intake identity, even after navigation or acknowledgement.
	db.run(`CREATE TABLE IF NOT EXISTS tg_inbox_archives (
		update_id INTEGER PRIMARY KEY REFERENCES tg_inbox(update_id),
		target_id TEXT NOT NULL
	)`);
	const selectArchive = db.query("SELECT target_id FROM tg_inbox_archives WHERE update_id = ?");
	const insertArchive = db.query("INSERT INTO tg_inbox_archives (update_id, target_id) VALUES (?, ?)");
	const selectBefore = db.query(`SELECT update_id, chat_id, message_id, conversation_id, payload_json, committed_at
		FROM tg_inbox WHERE conversation_id = ? AND update_id < ? AND committed_at IS NULL ORDER BY update_id`);
	function archivedTarget(updateId: number, laneKey: string): string | null {
		updateIdSchema.parse(updateId);
		archiveScope(laneKey);
		const assignment = selectArchive.get(updateId);
		if (!assignment) return null;
		const target = assignmentSchema.parse(assignment).target_id;
		archiveScope(laneKey, target);
		const row = rowSchema.parse(selectOne.get(updateId));
		if (row.conversation_id !== laneKey || row.chat_id !== archiveScope(laneKey)) {
			throw new Error("Telegram inbox archive has a mismatched lane");
		}
		return target;
	}
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
				log.error("telegram inbox record failed", undefined, {
					updateId: idSchema.safeParse(updateId).success ? updateId : null,
					chatId: idSchema.safeParse(payload.chatId).success ? payload.chatId : null,
					messageId: idSchema.safeParse(payload.messageId).success ? payload.messageId : null,
					errorKind: err instanceof Error ? err.name : "unknown",
				});
				throw err;
			}
		},
		pending() {
			try {
				return selectPending.all().map(decode);
			} catch (err) {
				log.error("telegram inbox pending read failed", undefined, { errorKind: err instanceof Error ? err.name : "unknown" });
				throw err;
			}
		},
		pendingIds(updateIds, laneKey) {
			z.array(updateIdSchema).parse(updateIds);
			z.string().min(1).parse(laneKey);
			if (new Set(updateIds).size !== updateIds.length) throw new Error("Duplicate Telegram inbox batch identities");
			return updateIds.filter((id) => {
				const row = rowSchema.parse(selectOne.get(id));
				if (row.conversation_id !== laneKey) throw new Error(`Telegram inbox update ${id} is in another lane`);
				if (row.committed_at !== null) return false;
				decode(row);
				return true;
			});
		},
		archivePendingBefore(laneKey, beforeUpdateId, targetId) {
			const fields = { laneKey, beforeUpdateId, targetId };
			try {
				const chatId = archiveScope(laneKey, targetId);
				updateIdSchema.parse(beforeUpdateId);
				const count = db.transaction(() => {
					const target = z.object({ id: rollingTargetSchema, chat_id: idSchema }).parse(
						db.query("SELECT id, chat_id FROM conversations WHERE id = ?").get(targetId),
					);
					if (target.chat_id !== chatId) throw new Error("Telegram inbox archive target has a mismatched chat");
					let assigned = 0;
					for (const raw of selectBefore.all(laneKey, beforeUpdateId)) {
						const entry = decode(raw);
						if (entry.payload.chatId !== chatId) throw new Error("Telegram inbox archive input has a mismatched chat");
						if (archivedTarget(entry.updateId, laneKey) !== null) continue;
						insertArchive.run(entry.updateId, targetId);
						assigned++;
					}
					return assigned;
				})();
				log.info("telegram inbox inputs archived", { ...fields, archivedInputs: count });
				return count;
			} catch (err) {
				log.error("telegram inbox archive failed — rolled back", undefined, {
					laneKey: dmLaneSchema.safeParse(laneKey).success ? laneKey : null,
					beforeUpdateId: updateIdSchema.safeParse(beforeUpdateId).success ? beforeUpdateId : null,
					targetId: rollingTargetSchema.safeParse(targetId).success ? targetId : null,
					errorKind: err instanceof Error ? err.name : "unknown",
				});
				throw err;
			}
		},
		archivedTarget,
		hasPendingBefore(laneKey, beforeUpdateId) {
			const chatId = archiveScope(laneKey);
			updateIdSchema.parse(beforeUpdateId);
			const entries = selectBefore.all(laneKey, beforeUpdateId).map(decode);
			for (const entry of entries) {
				if (entry.payload.chatId !== chatId) throw new Error("Telegram inbox pending input has a mismatched chat");
			}
			return entries.length !== 0;
		},
		assertRouteable(updateIds, laneKey) {
			z.string().min(1).parse(laneKey);
			z.array(updateIdSchema).min(1).parse(updateIds);
			if (new Set(updateIds).size !== updateIds.length) return false;
			return updateIds.every((id) => {
				const raw = selectOne.get(id);
				if (!raw) return false;
				const row = rowSchema.parse(raw);
				if (row.committed_at !== null || row.conversation_id !== laneKey) return false;
				decode(row);
				// Any assignment fences classification, even if its target
				// happens to be the currently selected conversation.
				return selectArchive.get(id) === null;
			});
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
						if (!row) throw new Error(`Telegram inbox update ${id} is missing`);
						const lane = decode(row).payload.conversationId;
						const target = selectArchive.get(id) ? archivedTarget(id, lane) : null;
						// Normal routing commits by original lane; history-only
						// intake may also commit directly by its assigned target.
						if (lane !== conversationId && target !== conversationId) {
							throw new Error(`Telegram inbox update ${id} is in another conversation`);
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
				log.error("telegram inbox batch failed — rolled back", undefined, {
					updateIds: z.array(idSchema).safeParse(updateIds).success ? updateIds : null,
					errorKind: err instanceof Error ? err.name : "unknown",
				});
				throw err;
			}
		},
	};
}
