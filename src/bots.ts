import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { appIdOf } from "./conversation-address.ts";

export type BotId = string;
export const LITTLE_GOBLIN_BOT_ID: BotId = "little-goblin";

export interface Bot {
	id: BotId;
	name: string;
	mainConversationId: string;
}

interface BotMembership {
	botId: BotId;
	mainOrdinal: number | null;
}

type Conversion =
	| { kind: "converted" | "existing"; bot: Bot }
	| { kind: "missing" | "notSideChat" | "archived" | "busy" };

export function ensureBotsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS bots (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)
	`);
	db.run("INSERT OR IGNORE INTO bots (id, name, created_at) VALUES (?, 'Little Goblin', 0)", [
		LITTLE_GOBLIN_BOT_ID,
	]);
	db.run(`
		CREATE TABLE IF NOT EXISTS bot_chats (
			conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
			bot_id TEXT NOT NULL REFERENCES bots(id),
			main_ordinal INTEGER CHECK (main_ordinal > 0),
			UNIQUE (bot_id, main_ordinal)
		)
	`);
}

export function makeBotStore(db: Database) {
	const source = db.query<
		{ projectId: string | null; parentId: string | null; archivedAt: string | null; rolling: number },
		[string]
	>(`
		SELECT project_id AS projectId, parent_conversation_id AS parentId, archived_at AS archivedAt,
			EXISTS (SELECT 1 FROM app_rolls WHERE conversation_id = conversations.id) AS rolling
		FROM conversations WHERE id = ?
	`);
	const membership = db.query<BotMembership, [string]>(`
		SELECT bot_id AS botId, main_ordinal AS mainOrdinal FROM bot_chats WHERE conversation_id = ?
	`);
	const main = db.query<Bot, [BotId]>(`
		SELECT bots.id, bots.name, bot_chats.conversation_id AS mainConversationId
		FROM bots JOIN bot_chats ON bot_chats.bot_id = bots.id
		WHERE bots.id = ? AND bot_chats.main_ordinal IS NOT NULL
		ORDER BY bot_chats.main_ordinal DESC LIMIT 1
	`);
	const list = db.query<Bot, []>(`
		SELECT bots.id, bots.name, bot_chats.conversation_id AS mainConversationId
		FROM bots JOIN bot_chats ON bot_chats.bot_id = bots.id
		WHERE bot_chats.main_ordinal = (
			SELECT MAX(main_ordinal) FROM bot_chats WHERE bot_id = bots.id
		)
		ORDER BY bots.created_at DESC, bots.id
	`);
	const insert = db.query("INSERT INTO bots (id, name, created_at) VALUES (?, ?, ?)");
	const attachMain = db.query(`
		INSERT INTO bot_chats (conversation_id, bot_id, main_ordinal) VALUES (?, ?, 1)
	`);

	const convert = db.transaction(
		(id: string, name: string, createdAt: number, busy: (id: string) => boolean): Conversion => {
			if (appIdOf(id) === null) return { kind: "notSideChat" };
			const row = source.get(id);
			if (row === null) return { kind: "missing" };
			if (row.projectId !== null || row.parentId !== null || row.rolling) {
				return { kind: "notSideChat" };
			}
			if (row.archivedAt !== null) return { kind: "archived" };
			const member = membership.get(id);
			if (member !== null) {
				const bot = main.get(member.botId);
				return bot?.mainConversationId === id ? { kind: "existing", bot } : { kind: "notSideChat" };
			}
			if (busy(id)) return { kind: "busy" };
			const bot = { id: randomUUID(), name, mainConversationId: id };
			insert.run(bot.id, bot.name, createdAt);
			attachMain.run(id, bot.id);
			return { kind: "converted", bot };
		},
	);

	return {
		membership: (id: string) => membership.get(id),
		list: () => list.all(),
		convertSideChat: convert.immediate,
	};
}

export type BotStore = ReturnType<typeof makeBotStore>;
