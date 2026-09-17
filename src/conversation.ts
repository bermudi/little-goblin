// Conversation store — SQLite (bun:sqlite, WAL). A conversation is keyed by
// its Telegram address: the DM itself, or a forum topic in the operator's
// group. Owns meta (cwd, model/thinking overrides, epoch) and the durable
// event history as UIMessage-format JSON rows.
//
// Durability = WAL + transactions, not tmp/fsync/rename.

import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";

// ---------- identity ----------

// The Telegram address IS the conversation identity.
export type ConversationAddress =
	| { kind: "dm"; chatId: number }
	| { kind: "topic"; chatId: number; threadId: number };

export function addressId(addr: ConversationAddress): string {
	return addr.kind === "dm" ? `dm:${addr.chatId}` : `topic:${addr.chatId}:${addr.threadId}`;
}

// ---------- types ----------

export interface Conversation {
	id: string;
	chatId: number;
	threadId: number | null;
	title: string | null;
	cwd: string;
	model: string | null; // "<provider>/<model-id>" override; null = config default
	thinking: string | null; // override; null = config default
	epoch: number;
	createdAt: string;
}

export interface ConversationMetaPatch {
	title?: string;
	cwd?: string;
	model?: string | null;
	thinking?: string | null;
}

export interface ConversationStore {
	// Get-or-create by Telegram address. New conversations start at cwd =
	// defaultCwd, epoch 0.
	resolve(addr: ConversationAddress, defaultCwd: string): Conversation;
	get(id: string): Conversation | null;
	setMeta(id: string, patch: ConversationMetaPatch): void;
	// Settings changes and cancellation bump the epoch; in-flight turns
	// fence themselves against it.
	bumpEpoch(id: string): number;
	// Append UIMessages in one transaction; seq is assigned here.
	append(id: string, messages: UIMessage[]): void;
	history(id: string): UIMessage[];
	close(): void;
}

// ---------- store ----------

interface Row {
	id: string;
	chat_id: number;
	thread_id: number | null;
	title: string | null;
	cwd: string;
	model: string | null;
	thinking: string | null;
	epoch: number;
	created_at: string;
}

function toConversation(r: Row): Conversation {
	return {
		id: r.id,
		chatId: r.chat_id,
		threadId: r.thread_id,
		title: r.title,
		cwd: r.cwd,
		model: r.model,
		thinking: r.thinking,
		epoch: r.epoch,
		createdAt: r.created_at,
	};
}

export function openStore(dbPath: string): ConversationStore {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run(`
		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			chat_id INTEGER NOT NULL,
			thread_id INTEGER,
			title TEXT,
			cwd TEXT NOT NULL,
			model TEXT,
			thinking TEXT,
			epoch INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`);
	db.run(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			data TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(conversation_id, seq)
		)`);

	const qGet = db.query<Row, [string]>("SELECT * FROM conversations WHERE id = ?");
	const qInsertConv = db.query(
		`INSERT INTO conversations (id, chat_id, thread_id, title, cwd, created_at)
		 VALUES (?, ?, ?, NULL, ?, ?)`,
	);
	const qHistory = db.query<{ data: string }, [string]>(
		"SELECT data FROM events WHERE conversation_id = ? ORDER BY seq",
	);
	const qNextSeq = db.query<{ n: number | null }, [string]>(
		"SELECT MAX(seq) AS n FROM events WHERE conversation_id = ?",
	);
	const qInsertEvent = db.query(
		"INSERT INTO events (conversation_id, seq, role, data, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const qEpoch = db.query<{ epoch: number }, [string]>(
		"SELECT epoch FROM conversations WHERE id = ?",
	);

	return {
		resolve(addr, defaultCwd) {
			const id = addressId(addr);
			const existing = qGet.get(id);
			if (existing) return toConversation(existing);
			qInsertConv.run(
				id,
				addr.chatId,
				addr.kind === "topic" ? addr.threadId : null,
				defaultCwd,
				new Date().toISOString(),
			);
			const created = qGet.get(id);
			if (!created) throw new Error(`conversation ${id} insert failed`);
			return toConversation(created);
		},

		get(id) {
			const row = qGet.get(id);
			return row ? toConversation(row) : null;
		},

		setMeta(id, patch) {
			const sets: string[] = [];
			const vals: (string | number | null)[] = [];
			if (patch.title !== undefined) {
				sets.push("title = ?");
				vals.push(patch.title);
			}
			if (patch.cwd !== undefined) {
				sets.push("cwd = ?");
				vals.push(patch.cwd);
			}
			if (patch.model !== undefined) {
				sets.push("model = ?");
				vals.push(patch.model);
			}
			if (patch.thinking !== undefined) {
				sets.push("thinking = ?");
				vals.push(patch.thinking);
			}
			if (sets.length === 0) return;
			vals.push(id);
			db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, vals);
		},

		bumpEpoch(id) {
			db.run("UPDATE conversations SET epoch = epoch + 1 WHERE id = ?", [id]);
			const row = qEpoch.get(id);
			if (!row) throw new Error(`conversation ${id} not found`);
			return row.epoch;
		},

		append(id, messages) {
			db.transaction(() => {
				const start = qNextSeq.get(id)?.n ?? 0;
				const now = new Date().toISOString();
				for (const [i, m] of messages.entries()) {
					qInsertEvent.run(id, start + i + 1, m.role, JSON.stringify(m), now);
				}
			})();
		},

		history(id) {
			return qHistory.all(id).map((r) => JSON.parse(r.data) as UIMessage);
		},

		close() {
			db.close();
		},
	};
}
