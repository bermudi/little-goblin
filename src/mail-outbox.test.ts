// The outbox's invariants: send queues a pending row with a 24h fuse,
// decisions are compare-and-set (one winner between a tap and the
// sweeper), and expiry only ever takes pending rows.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openOutbox, OUTBOX_TTL_MS, type OutboxStore } from "./mail-outbox.ts";
import { tmpDb } from "./testkit.ts";

const NOW = new Date("2026-09-26T10:00:00.000Z");
const ADDRESS = { chatId: -100, threadId: 7 };

function store(): OutboxStore {
	return openOutbox(tmpDb("goblin-outbox-"));
}

describe("mail outbox", () => {
	test("queue writes a pending row with a 24h fuse", () => {
		const s = store();
		const row = s.queue({ to: ["a@x.com"], subject: "hi", body: "hello", address: ADDRESS }, NOW);
		expect(row.status).toBe("pending");
		expect(row.draftMessageId).toBeNull();
		expect(row.cc).toEqual([]);
		expect(new Date(row.expiresAt).getTime() - NOW.getTime()).toBe(OUTBOX_TTL_MS);
		expect(s.get(row.id)).toEqual(row);
	});

	test("queue accepts an app conversation target", () => {
		const s = store();
		const row = s.queue(
			{ to: ["a@x.com"], subject: "hi", body: "hello", address: { target: "app/chat-1" } },
			NOW,
		);
		expect(row.target).toBe("app/chat-1");
		expect(row.chatId).toBe(0);
		expect(row.threadId).toBeNull();
		s.close();
	});

	test("a pre-target outbox migrates its destination without deciding it", () => {
		const path = tmpDb("goblin-outbox-");
		const db = new Database(path);
		db.exec(`CREATE TABLE mail_outbox (
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
		db.query(`INSERT INTO mail_outbox
			(to_json, subject, body, chat_id, thread_id, draft_message_id, status, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
			'["a@x.com"]',
			"hi",
			"body",
			-100,
			7,
			55,
			NOW.toISOString(),
			"2026-09-27T10:00:00.000Z",
		);
		db.close();
		const s = openOutbox(path);
		const row = s.get(1)!;
		expect(row.target).toBe("topic:-100:7");
		expect(row.chatId).toBe(-100);
		expect(row.threadId).toBe(7);
		expect(row.draftMessageId).toBe(55);
		expect(row.status).toBe("pending");
		s.close();
	});

	test("bindDraft pins the draft message; rows survive a reopen", () => {
		const path = tmpDb("goblin-outbox-");
		const s = openOutbox(path);
		const row = s.queue(
			{
				to: ["a@x.com"],
				cc: ["b@y.com"],
				subject: "hi",
				body: "hello",
				replyToId: "m1",
				address: ADDRESS,
			},
			NOW,
		);
		s.bindDraft(row.id, 4242);
		s.close();
		const reopened = openOutbox(path);
		const back = reopened.get(row.id)!;
		expect(back.draftMessageId).toBe(4242);
		expect(back.cc).toEqual(["b@y.com"]);
		expect(back.replyToId).toBe("m1");
		expect(back.status).toBe("pending");
		reopened.close();
	});

	test("decide is compare-and-set — only the first decision lands", () => {
		const s = store();
		const row = s.queue({ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		expect(s.decide(row.id, "sent", NOW, "gmail-1")).toBe(true);
		// A double-tap, or the sweeper racing the tap, loses.
		expect(s.decide(row.id, "cancelled", NOW)).toBe(false);
		expect(s.decide(9999, "cancelled", NOW)).toBe(false);
		const back = s.get(row.id)!;
		expect(back.status).toBe("sent");
		expect(back.sentId).toBe("gmail-1");
		expect(back.decidedAt).toBe(NOW.toISOString());
	});

	test("expireDue takes only lapsed pending rows", () => {
		const s = store();
		const old = s.queue(
			{ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		const fresh = s.queue({ to: ["b@y.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		const done = s.queue(
			{ to: ["c@z.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		s.decide(done.id, "cancelled", NOW);
		const expired = s.expireDue(NOW);
		expect(expired.map((r) => r.id)).toEqual([old.id]);
		expect(expired[0]!.status).toBe("expired");
		expect(s.get(fresh.id)!.status).toBe("pending");
		expect(s.get(done.id)!.status).toBe("cancelled");
	});

	test("expireDue leaves excluded rows pending — a mid-send draft is not the sweep's", () => {
		const s = store();
		const sending = s.queue(
			{ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		const lapsed = s.queue(
			{ to: ["b@y.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		const expired = s.expireDue(NOW, (id) => id === sending.id);
		expect(expired.map((r) => r.id)).toEqual([lapsed.id]);
		expect(s.get(sending.id)!.status).toBe("pending");
		expect(s.get(lapsed.id)!.status).toBe("expired");
	});
});
