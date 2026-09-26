// The mail outbox — the send gate's memory (DESIGN.md, "Email").
// `send` never sends: it queues a pending row and the operator's tap on
// the draft's Send/Cancel buttons decides it. Rows survive restarts, so
// pending drafts stay tappable across them; expiry (+24h) is swept by
// the mail watcher. Every transition logs the recipient domain — never
// the body.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { domainOf } from "./mail.ts";
import { log } from "./log.ts";

export type OutboxStatus = "pending" | "sent" | "cancelled" | "expired";

export interface OutboxEntry {
	id: number;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	/** Gmail message id this answers — threading resolves at send time. */
	replyToId: string | null;
	/** Pinned Telegram address — the draft lives where the tool ran. */
	chatId: number;
	threadId: number | null;
	/** The draft message carrying the Send/Cancel buttons, once posted. */
	draftMessageId: number | null;
	status: OutboxStatus;
	createdAt: string;
	expiresAt: string;
	decidedAt: string | null;
	/** Gmail's id for the sent message — set on send. */
	sentId: string | null;
}

export interface QueueDraft {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	replyToId?: string | null;
	address: { chatId: number; threadId: number | null };
}

export interface OutboxStore {
	queue(input: QueueDraft, now?: Date): OutboxEntry;
	bindDraft(id: number, messageId: number): void;
	get(id: number): OutboxEntry | null;
	/** Compare-and-set decision: applies only while the row is still
	 *  pending — a double-tap or a sweeper race resolves to one winner. */
	decide(id: number, to: Exclude<OutboxStatus, "pending">, now?: Date, sentId?: string): boolean;
	/** Mark every expired pending row; the watcher edits their drafts. */
	expireDue(now?: Date): OutboxEntry[];
	close(): void;
}

export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

const rowSchema = z.object({
	id: z.number(),
	to_json: z.string(),
	cc_json: z.string().nullable(),
	subject: z.string(),
	body: z.string(),
	reply_to_id: z.string().nullable(),
	chat_id: z.number(),
	thread_id: z.number().nullable(),
	draft_message_id: z.number().nullable(),
	status: z.enum(["pending", "sent", "cancelled", "expired"]),
	created_at: z.string(),
	expires_at: z.string(),
	decided_at: z.string().nullable(),
	sent_id: z.string().nullable(),
});

function rowToEntry(row: unknown): OutboxEntry {
	const r = rowSchema.parse(row);
	return {
		id: r.id,
		to: JSON.parse(r.to_json) as string[],
		cc: r.cc_json === null ? [] : (JSON.parse(r.cc_json) as string[]),
		subject: r.subject,
		body: r.body,
		replyToId: r.reply_to_id,
		chatId: r.chat_id,
		threadId: r.thread_id,
		draftMessageId: r.draft_message_id,
		status: r.status,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		decidedAt: r.decided_at,
		sentId: r.sent_id,
	};
}

export function openOutbox(dbPath: string): OutboxStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS mail_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		to_json TEXT NOT NULL,
		cc_json TEXT,
		subject TEXT NOT NULL,
		body TEXT NOT NULL,
		reply_to_id TEXT,
		chat_id INTEGER NOT NULL,
		thread_id INTEGER,
		draft_message_id INTEGER,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		decided_at TEXT,
		sent_id TEXT
	)`);

	const qGet = db.query("SELECT * FROM mail_outbox WHERE id = ?");
	const qInsert = db.query(`INSERT INTO mail_outbox
		(to_json, cc_json, subject, body, reply_to_id, chat_id, thread_id,
		 draft_message_id, status, created_at, expires_at, decided_at, sent_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL, NULL)`);
	const qBind = db.query("UPDATE mail_outbox SET draft_message_id = ? WHERE id = ?");
	const qDecide = db.query(
		"UPDATE mail_outbox SET status = ?, decided_at = ?, sent_id = ? WHERE id = ? AND status = 'pending'",
	);
	const qExpired = db.query(
		"SELECT * FROM mail_outbox WHERE status = 'pending' AND expires_at <= ? ORDER BY id",
	);

	return {
		queue(input, now = new Date()) {
			const created = now.toISOString();
			const res = qInsert.run(
				JSON.stringify(input.to),
				input.cc?.length ? JSON.stringify(input.cc) : null,
				input.subject,
				input.body,
				input.replyToId ?? null,
				input.address.chatId,
				input.address.threadId,
				created,
				new Date(now.getTime() + OUTBOX_TTL_MS).toISOString(),
			);
			const id = Number(res.lastInsertRowid);
			log.info("mail outbox queued", {
				outbox: id,
				to: input.to.map(domainOf),
				...(input.cc?.length ? { cc: input.cc.map(domainOf) } : {}),
				...(input.replyToId ? { reply: true } : {}),
			});
			return rowToEntry(qGet.get(id));
		},

		bindDraft(id, messageId) {
			qBind.run(messageId, id);
		},

		get(id) {
			const row = qGet.get(id);
			return row === null ? null : rowToEntry(row);
		},

		decide(id, to, now = new Date(), sentId?: string) {
			const res = qDecide.run(to, now.toISOString(), sentId ?? null, id);
			if (res.changes === 0) return false;
			const entry = rowToEntry(qGet.get(id));
			log.info(`mail outbox ${to}`, {
				outbox: id,
				to: entry.to.map(domainOf),
			});
			return true;
		},

		expireDue(now = new Date()) {
			const rows = qExpired.all(now.toISOString()).map(rowToEntry);
			for (const row of rows) {
				// decide() re-checks pending — a tap racing the sweep wins.
				this.decide(row.id, "expired", now);
			}
			return rows.map((r) => this.get(r.id)!);
		},

		close() {
			db.close();
		},
	};
}
