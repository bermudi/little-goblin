// `send` never sends: it queues a pending row and the operator's tap
// decides it. Rows survive restarts, so pending drafts stay tappable
// across them. Every transition logs the recipient domain — never the
// body.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { domainOf } from "./mail.ts";
import { log } from "./log.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";
import {
	telegramAddressOf,
	telegramTarget,
	validTarget,
	type ConversationTarget,
} from "./targets.ts";

export type OutboxStatus = "pending" | "sent" | "cancelled" | "expired";

export interface OutboxEntry {
	id: number;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	/** Gmail message id this answers — threading resolves at send time. */
	replyToId: string | null;
	/** Pinned conversation address — the draft lives where the tool ran. */
	target: ConversationTarget;
	/** Legacy transport projection derived from `target`; app rows use 0/null. */
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
	/** The authenticated decision lane ("app" or "telegram:<user>"). */
	decidedBy: string | null;
}

export interface QueueDraft {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	replyToId?: string | null;
	address: { target: ConversationTarget } | { chatId: number; threadId: number | null };
}

export interface OutboxStore {
	queue(input: QueueDraft, now?: Date): OutboxEntry;
	bindDraft(id: number, messageId: number): void;
	get(id: number): OutboxEntry | null;
	/** Compare-and-set decision: applies only while the row is still
	 *  pending — a double-tap or a sweeper race resolves to one winner. */
	decide(
		id: number,
		to: Exclude<OutboxStatus, "pending">,
		now?: Date,
		sentId?: string,
		actor?: string,
	): boolean;
	/** Pending rows in queue order — the operator's actionable inbox. */
	pending(): OutboxEntry[];
	/** Mark every expired pending row; the watcher edits their drafts.
	 *  Rows the caller excludes (a send in flight) stay pending — the
	 *  send's own verdict decides them, and the next sweep retries. */
	expireDue(now?: Date, exclude?: (id: number) => boolean): OutboxEntry[];
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
	target: z.string().refine(validTarget),
	draft_message_id: z.number().nullable(),
	status: z.enum(["pending", "sent", "cancelled", "expired"]),
	created_at: z.string(),
	expires_at: z.string(),
	decided_at: z.string().nullable(),
	sent_id: z.string().nullable(),
	decided_by: z.string().nullable(),
});

const addressArraySchema = z.array(z.string());

// Address columns are JSON arrays — parse them against the shape so
// corruption names itself with the row, instead of surfacing later as
// a mislabeled `to.map is not a function`.
function parseAddresses(id: number, field: string, json: string): string[] {
	try {
		return addressArraySchema.parse(JSON.parse(json));
	} catch (err) {
		throw new Error(
			`mail outbox row ${id}: corrupt ${field} — ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function rowToEntry(row: unknown): OutboxEntry {
	const r = rowSchema.parse(row);
	const telegram = telegramAddressOf(r.target);
	return {
		id: r.id,
		to: parseAddresses(r.id, "to", r.to_json),
		cc: r.cc_json === null ? [] : parseAddresses(r.id, "cc", r.cc_json),
		subject: r.subject,
		body: r.body,
		replyToId: r.reply_to_id,
		target: r.target,
		chatId: telegram?.chatId ?? 0,
		threadId: telegram?.threadId ?? null,
		draftMessageId: r.draft_message_id,
		status: r.status,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		decidedAt: r.decided_at,
		sentId: r.sent_id,
		decidedBy: r.decided_by,
	};
}

export function openOutbox(dbPath: string): OutboxStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	db.exec(`CREATE TABLE IF NOT EXISTS mail_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		to_json TEXT NOT NULL,
		cc_json TEXT,
		subject TEXT NOT NULL,
		body TEXT NOT NULL,
		reply_to_id TEXT,
		target TEXT NOT NULL,
		chat_id INTEGER NOT NULL DEFAULT 0,
		thread_id INTEGER,
		draft_message_id INTEGER,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		decided_at TEXT,
		sent_id TEXT,
		decided_by TEXT
	)`);
	const cols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(mail_outbox)")
			.all()
			.map((c) => c.name),
	);
	if (!cols.has("target")) {
		db.exec("ALTER TABLE mail_outbox ADD COLUMN target TEXT");
		db.exec(`UPDATE mail_outbox SET target =
			CASE WHEN thread_id IS NULL THEN 'dm:' || chat_id
			     ELSE 'topic:' || chat_id || ':' || thread_id END
			WHERE target IS NULL`);
	}
	if (!cols.has("decided_by")) {
		db.exec("ALTER TABLE mail_outbox ADD COLUMN decided_by TEXT");
	}

	const qGet = db.query("SELECT * FROM mail_outbox WHERE id = ?");
	const qInsert = db.query(`INSERT INTO mail_outbox
		(to_json, cc_json, subject, body, reply_to_id, target, chat_id, thread_id,
		 draft_message_id, status, created_at, expires_at, decided_at, sent_id, decided_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL, NULL, NULL)`);
	const qBind = db.query("UPDATE mail_outbox SET draft_message_id = ? WHERE id = ?");
	const qDecide = db.query(
		"UPDATE mail_outbox SET status = ?, decided_at = ?, sent_id = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
	);
	const qPending = db.query("SELECT * FROM mail_outbox WHERE status = 'pending' ORDER BY id");
	const qExpired = db.query(
		"SELECT * FROM mail_outbox WHERE status = 'pending' AND expires_at <= ? ORDER BY id",
	);

	return {
		queue(input, now = new Date()) {
			const created = now.toISOString();
			const target =
				"target" in input.address
					? input.address.target
					: telegramTarget(input.address.chatId, input.address.threadId);
			if (!validTarget(target)) throw new Error(`invalid outbox destination "${target}"`);
			const telegram = telegramAddressOf(target);
			const res = qInsert.run(
				JSON.stringify(input.to),
				input.cc?.length ? JSON.stringify(input.cc) : null,
				input.subject,
				input.body,
				input.replyToId ?? null,
				target,
				telegram?.chatId ?? 0,
				telegram?.threadId ?? null,
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

		decide(id, to, now = new Date(), sentId?: string, actor?: string) {
			const res = qDecide.run(to, now.toISOString(), sentId ?? null, actor ?? null, id);
			if (res.changes === 0) return false;
			const entry = rowToEntry(qGet.get(id));
			log.info(`mail outbox ${to}`, {
				outbox: id,
				to: entry.to.map(domainOf),
				...(actor !== undefined ? { decidedBy: actor } : {}),
			});
			return true;
		},

		pending() {
			return qPending.all().map(rowToEntry);
		},

		expireDue(now = new Date(), exclude?: (id: number) => boolean) {
			const due = qExpired
				.all(now.toISOString())
				.map(rowToEntry)
				.filter((row) => !exclude?.(row.id));
			// The returned set is exactly the rows THIS sweep decided:
			// decide() re-checks pending and a racing tap wins its CAS, so
			// a row that lost would return with someone else's verdict —
			// and the caller would stamp "expired — never sent" over it
			// (unreachable today, honest under any refactor).
			const expired: OutboxEntry[] = [];
			for (const row of due) {
				if (this.decide(row.id, "expired", now)) expired.push(this.get(row.id)!);
			}
			return expired;
		},

		close() {
			db.close();
		},
	};
}
