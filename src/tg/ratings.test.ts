// The tap record: round-trip through the real store, append-only with
// latest-wins reads — including across a reopened handle (a restart).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { openRatings } from "./ratings.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-ratings-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("reply ratings", () => {
	test("record → latest round-trips all fields", () => {
		const store = openStore(tmpdb());
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
		const store = openStore(tmpdb());
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
		const path = tmpdb();
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

	test("a row joins back to its reply through events", () => {
		const store = openStore(tmpdb());
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
