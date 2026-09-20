// Conversation store — SQLite (bun:sqlite, WAL). A conversation is keyed by
// its Telegram address: the DM itself, or a forum topic in the operator's
// group. Owns meta (model/thinking overrides, epoch) and the durable
// event history as UIMessage-format JSON rows.
//
// Durability = WAL + transactions, not tmp/fsync/rename.

import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { z } from "zod";

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
	// Telegram handed this topic a placeholder name (forum_topic_created
	// is_name_implicit) — the bot owes it a real one. Cleared by any
	// explicit rename or a successful auto-title.
	titleImplicit: boolean;
	model: string | null; // "<provider>/<model-id>" override; null = config default
	thinking: string | null; // override; null = config default
	voice: boolean;
	epoch: number;
	createdAt: string;
}

export interface ConversationMetaPatch {
	title?: string;
	titleImplicit?: boolean;
	model?: string | null;
	thinking?: string | null;
	voice?: boolean;
}

export interface ConversationStore {
	// Get-or-create by Telegram address. New conversations start at epoch 0.
	// The cwd column still exists in the table (NOT NULL, no default —
	// existing DBs need it stamped) but cwd is no longer per-conversation
	// state: tools always run in the deployment workspace.
	resolve(addr: ConversationAddress, defaultCwd: string): Conversation;
	get(id: string): Conversation | null;
	setMeta(id: string, patch: ConversationMetaPatch): void;
	// Settings changes and cancellation bump the epoch; in-flight turns
	// fence themselves against it.
	bumpEpoch(id: string): number;
	// Settings patch + epoch bump in one transaction — a settings write
	// that fences in-flight turns must never land half-applied.
	applySettings(id: string, patch: ConversationMetaPatch): number;
	// Append UIMessages in one transaction; seq is assigned here.
	// anchorSeq marks a response with the seq of the user event that
	// triggered its turn — history() uses it for causal ordering.
	append(id: string, messages: UIMessage[], opts?: { anchorSeq?: number | null }): void;
	// The model-facing view: causal order, not arrival order. Anchored
	// assistant events sort immediately after their triggering user
	// event; everything else falls back to seq.
	history(id: string): UIMessage[];
	// Seq of the newest user event — a turn's response anchors to it.
	lastUserSeq(id: string): number | null;
	close(): void;
}

// ---------- store ----------

interface Row {
	id: string;
	chat_id: number;
	thread_id: number | null;
	title: string | null;
	title_implicit: number;
	cwd: string; // kept: column exists in existing DBs; never read into Conversation
	model: string | null;
	thinking: string | null;
	voice: number;
	epoch: number;
	created_at: string;
}

// Disk state is a boundary: history rows are validated on read, not
// trusted. Parts stay loosely typed — the runtime's converters own the
// per-part semantics — but a row that isn't a message envelope at all
// fails loud here instead of confusing the model layer downstream.
const uiMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["system", "user", "assistant"]),
	parts: z.array(z.looseObject({ type: z.string() })),
});

function toConversation(r: Row): Conversation {
	return {
		id: r.id,
		chatId: r.chat_id,
		threadId: r.thread_id,
		title: r.title,
		titleImplicit: r.title_implicit !== 0,
		model: r.model,
		thinking: r.thinking,
		voice: r.voice !== 0,
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
			title_implicit INTEGER NOT NULL DEFAULT 0,
			cwd TEXT NOT NULL,
			model TEXT,
			thinking TEXT,
			voice INTEGER NOT NULL DEFAULT 0,
			epoch INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`);
	// Existing DBs predate title_implicit — additive column, no rebuild.
	const convCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(conversations)")
			.all()
			.map((c) => c.name),
	);
	if (!convCols.has("title_implicit")) {
		db.run("ALTER TABLE conversations ADD COLUMN title_implicit INTEGER NOT NULL DEFAULT 0");
	}
	if (!convCols.has("voice")) {
		db.run("ALTER TABLE conversations ADD COLUMN voice INTEGER NOT NULL DEFAULT 0");
	}
	db.run(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			data TEXT NOT NULL,
			anchor_seq INTEGER,
			created_at TEXT NOT NULL,
			UNIQUE(conversation_id, seq)
		)`);
	// Existing DBs predate anchor_seq — additive column, no rebuild.
	const eventCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(events)")
			.all()
			.map((c) => c.name),
	);
	if (!eventCols.has("anchor_seq")) {
		db.run("ALTER TABLE events ADD COLUMN anchor_seq INTEGER");
	}

	const qGet = db.query<Row, [string]>("SELECT * FROM conversations WHERE id = ?");
	const qInsertConv = db.query(
		`INSERT INTO conversations (id, chat_id, thread_id, title, cwd, created_at)
		 VALUES (?, ?, ?, NULL, ?, ?)`,
	);
	const qHistory = db.query<
		{ seq: number; anchor_seq: number | null; data: string },
		[string]
	>(
		"SELECT seq, anchor_seq, data FROM events WHERE conversation_id = ? ORDER BY seq",
	);
	const qLastUserSeq = db.query<{ seq: number }, [string]>(
		"SELECT seq FROM events WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1",
	);
	const qNextSeq = db.query<{ n: number | null }, [string]>(
		"SELECT MAX(seq) AS n FROM events WHERE conversation_id = ?",
	);
	const qInsertEvent = db.query(
		"INSERT INTO events (conversation_id, seq, role, data, anchor_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const qEpoch = db.query<{ epoch: number }, [string]>(
		"SELECT epoch FROM conversations WHERE id = ?",
	);

	function applyPatch(id: string, patch: ConversationMetaPatch): void {
		const sets: string[] = [];
		const vals: (string | number | null)[] = [];
		if (patch.title !== undefined) {
			sets.push("title = ?");
			vals.push(patch.title);
		}
		if (patch.titleImplicit !== undefined) {
			sets.push("title_implicit = ?");
			vals.push(patch.titleImplicit ? 1 : 0);
		}
		if (patch.model !== undefined) {
			sets.push("model = ?");
			vals.push(patch.model);
		}
		if (patch.thinking !== undefined) {
			sets.push("thinking = ?");
			vals.push(patch.thinking);
		}
		if (patch.voice !== undefined) {
			sets.push("voice = ?");
			vals.push(patch.voice ? 1 : 0);
		}
		if (sets.length === 0) return;
		vals.push(id);
		db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, vals);
	}

	function bump(id: string): number {
		db.run("UPDATE conversations SET epoch = epoch + 1 WHERE id = ?", [id]);
		const row = qEpoch.get(id);
		if (!row) throw new Error(`conversation ${id} not found`);
		return row.epoch;
	}

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
			applyPatch(id, patch);
		},

		bumpEpoch(id) {
			return bump(id);
		},

		applySettings(id, patch) {
			return db.transaction(() => {
				applyPatch(id, patch);
				return bump(id);
			})();
		},

		append(id, messages, opts) {
			db.transaction(() => {
				const start = qNextSeq.get(id)?.n ?? 0;
				const now = new Date().toISOString();
				for (const [i, m] of messages.entries()) {
					qInsertEvent.run(
						id,
						start + i + 1,
						m.role,
						JSON.stringify(m),
						opts?.anchorSeq ?? null,
						now,
					);
				}
			})();
		},

		lastUserSeq(id) {
			return qLastUserSeq.get(id)?.seq ?? null;
		},

		history(id) {
			const rows = qHistory.all(id).map((r) => {
				let raw: unknown;
				try {
					raw = JSON.parse(r.data);
				} catch (err) {
					throw new Error(
						`conversation ${id}: invalid stored message — ${(err as Error).message}`,
					);
				}
				const parsed = uiMessageSchema.safeParse(raw);
				if (!parsed.success) {
					throw new Error(
						`conversation ${id}: invalid stored message — ${parsed.error.message}`,
					);
				}
				return { seq: r.seq, anchorSeq: r.anchor_seq, message: parsed.data as UIMessage };
			});
			// Arrival order stays on disk; this view sorts each anchored
			// response right after the user event that triggered its turn.
			// Key = anchor ?? seq, tiebreak = seq — an anchored response's
			// anchor always precedes its own seq, so it lands just after
			// its user event and before anything that arrived later.
			rows.sort((a, b) => {
				const ka = a.anchorSeq ?? a.seq;
				const kb = b.anchorSeq ?? b.seq;
				return ka - kb || a.seq - b.seq;
			});
			return rows.map((r) => r.message);
		},

		close() {
			db.close();
		},
	};
}
