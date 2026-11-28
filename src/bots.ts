import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { appIdOf } from "./conversation-address.ts";
import { LITTLE_GOBLIN_NOTE_OWNER } from "./note-owner.ts";

export type BotId = string;
export const LITTLE_GOBLIN_BOT_ID: BotId = LITTLE_GOBLIN_NOTE_OWNER;

export interface Bot {
	id: BotId;
	name: string;
	instructions: string;
	folder: string | null;
	mainConversationId: string;
	sideConversationIds: string[];
	canMoveBack: boolean;
}

export type BotPatch = { [K in "name" | "instructions" | "folder"]?: Bot[K] | undefined };

type BotRow = Omit<Bot, "canMoveBack" | "sideConversationIds"> & {
	sideConversationIds: string;
	canMoveBack: number;
};

function readBot(row: BotRow): Bot {
	return {
		...row,
		sideConversationIds: JSON.parse(row.sideConversationIds) as string[],
		canMoveBack: row.canMoveBack === 1,
	};
}

interface BotMembership {
	botId: BotId;
	mainOrdinal: number | null;
}

type Conversion =
	| { kind: "converted" | "existing"; bot: Bot }
	| { kind: "missing" | "notSideChat" | "archived" | "busy" };

type MoveBack =
	| { kind: "moved"; conversationId: string }
	| { kind: "missing" | "ineligible" | "busy" };

export function ensureBotsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS bots (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			instructions TEXT NOT NULL DEFAULT '',
			folder TEXT
		)
	`);
	const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(bots)").all().map(({ name }) => name));
	if (!columns.has("instructions")) {
		db.run("ALTER TABLE bots ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
	}
	if (!columns.has("folder")) {
		db.run("ALTER TABLE bots ADD COLUMN folder TEXT");
	}
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
	const currentBots = `
		SELECT bots.id, bots.name, bots.instructions, bots.folder, bot_chats.conversation_id AS mainConversationId,
			(SELECT json_group_array(conversation_id ORDER BY conversation_id)
				FROM bot_chats AS side
				WHERE side.bot_id = bots.id AND side.main_ordinal IS NULL) AS sideConversationIds,
			(bot_chats.main_ordinal = 1 AND NOT EXISTS (
				SELECT 1 FROM bot_chats AS other
				WHERE other.bot_id = bots.id AND other.conversation_id <> bot_chats.conversation_id
			) AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.bot_id = bots.id)) AS canMoveBack
		FROM bots JOIN bot_chats ON bot_chats.bot_id = bots.id
		WHERE bot_chats.main_ordinal = (
			SELECT MAX(main_ordinal) FROM bot_chats WHERE bot_id = bots.id
		)
	`;
	const main = db.query<BotRow, [BotId]>(`${currentBots} AND bots.id = ?`);
	const list = db.query<BotRow, []>(`
		${currentBots}
		ORDER BY bots.created_at DESC, bots.id
	`);
	const names = db.query<{ name: string }, [BotId]>("SELECT name FROM bots WHERE id = ?");
	const insert = db.query("INSERT INTO bots (id, name, created_at) VALUES (?, ?, ?)");
	const update = db.query("UPDATE bots SET name = ?, instructions = ?, folder = ? WHERE id = ?");
	const detach = db.query("DELETE FROM bot_chats WHERE conversation_id = ? AND bot_id = ?");
	const attachMain = db.query(`
		INSERT INTO bot_chats (conversation_id, bot_id, main_ordinal) VALUES (?, ?, 1)
	`);
	const attachSide = db.query(`
		INSERT INTO bot_chats (conversation_id, bot_id) VALUES (?, ?)
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
				return bot?.mainConversationId === id
					? { kind: "existing", bot: readBot(bot) }
					: { kind: "notSideChat" };
			}
			if (busy(id)) return { kind: "busy" };
			const bot: Bot = {
				id: randomUUID(), name, instructions: "", folder: null, mainConversationId: id,
				sideConversationIds: [], canMoveBack: true,
			};
			insert.run(bot.id, bot.name, createdAt);
			attachMain.run(id, bot.id);
			return { kind: "converted", bot };
		},
	);
	const patchActive = db.transaction((id: BotId, patch: BotPatch): Bot | null => {
		const row = main.get(id);
		if (row === null) return null;
		const next = {
			...row,
			name: patch.name ?? row.name,
			instructions: patch.instructions ?? row.instructions,
			folder: patch.folder === undefined ? row.folder : patch.folder,
		};
		update.run(next.name, next.instructions, next.folder, id);
		return readBot(next);
	});
	const moveBack = db.transaction((id: BotId, busy: (id: string) => boolean): MoveBack => {
		const row = main.get(id);
		if (row === null) return { kind: "missing" };
		if (row.canMoveBack !== 1) return { kind: "ineligible" };
		if (busy(row.mainConversationId)) return { kind: "busy" };
		detach.run(row.mainConversationId, id);
		return { kind: "moved", conversationId: row.mainConversationId };
	});

	return {
		membership: (id: string) => membership.get(id),
		get: (id: BotId) => {
			const row = main.get(id);
			return row === null ? null : readBot(row);
		},
		name: (id: BotId) => names.get(id)?.name ?? null,
		attachSideChat: (id: string, botId: BotId) => attachSide.run(id, botId),
		list: () => list.all().map(readBot),
		convertSideChat: convert.immediate,
		patch: patchActive.immediate,
		moveBack: moveBack.immediate,
	};
}

export type BotStore = ReturnType<typeof makeBotStore>;
