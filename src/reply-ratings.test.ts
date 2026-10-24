// The tap record: round-trip through the real store, append-only with
// latest-wins reads — including across a reopened handle (a restart).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openStore } from "./conversation.ts";
import { openRatings } from "./reply-ratings.ts";
import { tmpDb } from "./testkit.ts";

describe("reply ratings", () => {
	test("record → latest round-trips all fields", () => {
		const store = openStore(tmpDb("goblin-ratings-"));
		try {
			const ratings = openRatings(store.db);
			ratings.record({
				conversationId: "dm:1:2",
				anchorSeq: 7,
				chatId: 1,
				messageId: 42,
				rating: "up",
			});
			expect(ratings.latest(1, 42)).toMatchObject({
				conversationId: "dm:1:2",
				anchorSeq: 7,
				chatId: 1,
				messageId: 42,
				rating: "up",
			});
			// A reply with no user anchor stores null, not a phantom seq.
			ratings.record({
				conversationId: "dm:1:2",
				anchorSeq: null,
				chatId: 1,
				messageId: 43,
				rating: "down",
			});
			expect(ratings.latest(1, 43)?.anchorSeq).toBeNull();
		} finally {
			store.close();
		}
	});

	test("a vote change appends a second row; latest wins", () => {
		const store = openStore(tmpDb("goblin-ratings-"));
		try {
			const ratings = openRatings(store.db);
			const base = { conversationId: "dm:1:2", anchorSeq: 7, chatId: 1, messageId: 42 };
			ratings.record({ ...base, rating: "up" });
			ratings.record({ ...base, rating: "down" });
			expect(
				store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reply_ratings").get()?.n,
			).toBe(2);
			expect(ratings.latest(1, 42)?.rating).toBe("down");
			// Replies are keyed by message identity — another bubble is untouched.
			expect(ratings.latest(1, 43)).toBeNull();
		} finally {
			store.close();
		}
	});

	test("the record survives a reopened handle — a process restart", () => {
		const path = tmpDb("goblin-ratings-");
		const first = openStore(path);
		openRatings(first.db).record({
			conversationId: "topic:-100:9",
			anchorSeq: 3,
			chatId: -100,
			messageId: 5,
			rating: "down",
		});
		first.close();
		const second = openStore(path);
		try {
			expect(openRatings(second.db).latest(-100, 5)?.rating).toBe("down");
		} finally {
			second.close();
		}
	});

	test("app rows key the durable event, stay channel-separated, and latest wins", () => {
		const store = openStore(tmpDb("goblin-ratings-"));
		try {
			const ratings = openRatings(store.db);
			ratings.record({
				conversationId: "app/chat-01",
				anchorSeq: 1,
				chatId: 99,
				messageId: 7,
				rating: "down",
			});
			ratings.recordApp({
				conversationId: "app/chat-01",
				anchorSeq: 1,
				eventSeq: 2,
				rating: "up",
			});
			ratings.recordApp({
				conversationId: "app/chat-01",
				anchorSeq: 1,
				eventSeq: 2,
				rating: "down",
			});
			ratings.recordApp({
				conversationId: "app/chat-01",
				anchorSeq: 4,
				eventSeq: 5,
				rating: "up",
			});

			expect(ratings.latestEvent("app/chat-01", 2)).toMatchObject({
				channel: "app",
				conversationId: "app/chat-01",
				anchorSeq: 1,
				chatId: 0,
				messageId: 0,
				eventSeq: 2,
				rating: "down",
			});
			expect(ratings.listApp("app/chat-01").map((r) => [r.eventSeq, r.rating])).toEqual([
				[2, "down"],
				[5, "up"],
			]);
			expect(ratings.latest(99, 7)?.channel).toBe("telegram");
			expect(ratings.latest(0, 2)).toBeNull();
			expect(ratings.latestEvent("app/other", 2)).toBeNull();
		} finally {
			store.close();
		}
	});

	test("an existing Telegram-only table gains the app columns without losing rows", () => {
		const path = tmpDb("goblin-ratings-");
		const legacy = new Database(path);
		legacy.exec(`
			CREATE TABLE reply_ratings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversation_id TEXT NOT NULL,
				anchor_seq INTEGER,
				chat_id INTEGER NOT NULL,
				message_id INTEGER NOT NULL,
				rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
				created_at TEXT NOT NULL
			);
			INSERT INTO reply_ratings
				(conversation_id, anchor_seq, chat_id, message_id, rating, created_at)
			VALUES ('dm:1', 3, 1, 9, 'up', '2026-01-01T00:00:00Z');
		`);
		legacy.close();

		const store = openStore(path);
		try {
			const ratings = openRatings(store.db);
			expect(ratings.latest(1, 9)).toMatchObject({
				channel: "telegram",
				conversationId: "dm:1",
				anchorSeq: 3,
				eventSeq: null,
				rating: "up",
			});
			ratings.recordApp({
				conversationId: "app/chat-01",
				anchorSeq: 1,
				eventSeq: 2,
				rating: "down",
			});
			expect(ratings.latestEvent("app/chat-01", 2)?.rating).toBe("down");
		} finally {
			store.close();
		}
	});

	test("a row joins back to its reply through events", () => {
		const store = openStore(tmpDb("goblin-ratings-"));
		try {
			store.resolve({ kind: "topic", chatId: -100, threadId: 9 }, "/tmp");
			store.append("topic:-100:9", [{ id: "u1", role: "user", parts: [] }]);
			store.append("topic:-100:9", [{ id: "a1", role: "assistant", parts: [] }], {
				anchorSeq: 1,
			});
			const ratings = openRatings(store.db);
			ratings.record({
				conversationId: "topic:-100:9",
				anchorSeq: store.lastReplyAnchor("topic:-100:9"),
				chatId: -100,
				messageId: 5,
				rating: "up",
			});
			const joined = store.db
				.query<{ seq: number; role: string }, []>(
					`SELECT e.seq, e.role FROM reply_ratings r
					 JOIN events e ON e.conversation_id = r.conversation_id AND e.anchor_seq = r.anchor_seq
					 WHERE r.chat_id = -100 AND r.message_id = 5`,
				)
				.all();
			expect(joined).toEqual([{ seq: 2, role: "assistant" }]);
		} finally {
			store.close();
		}
	});
});
