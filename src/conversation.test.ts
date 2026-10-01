import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { addressId, appAddress, channelOf, openStore, type ConversationStore } from "./conversation.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-test-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const msg = (text: string): UIMessage => ({
	id: "m1",
	role: "user",
	parts: [{ type: "text", text }],
});

describe("conversation store", () => {
	test("acknowledged inbox writes use WAL FULL sync on the shared connection", () => {
		const store = openStore(tmpdb());
		const result = store.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
		expect(result?.synchronous).toBe(2);
		store.close();
	});

	test("history preserves valid top-level UI message metadata after reopening", () => {
		const path = tmpdb();
		const store = openStore(path);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(conv.id, [{ ...msg("hello"), metadata: { source: "test" } }]);
		store.close();
		const reopened = openStore(path);
		expect(reopened.history(conv.id)[0]?.metadata).toEqual({ source: "test" });
		reopened.close();
	});

	test("resolve creates then returns the same conversation", () => {
		const store = openStore(tmpdb());
		const a = store.resolve({ kind: "topic", chatId: -100, threadId: 7 }, "/w");
		expect(a.id).toBe(addressId({ kind: "topic", chatId: -100, threadId: 7 }));
		expect(a.epoch).toBe(0);
		const b = store.resolve({ kind: "topic", chatId: -100, threadId: 7 }, "/other");
		expect(b.id).toBe(a.id);
		store.close();
	});

	test("append + history round-trips UIMessages in order", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 42 }, "/w");
		store.append(c.id, [msg("one"), msg("two")]);
		store.append(c.id, [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] }]);
		const h = store.history(c.id);
		expect(h.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
		expect((h[0]!.parts[0] as { text: string }).text).toBe("one");
		store.close();
	});

	test("history interleaves an anchored response after its user event", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 42 }, "/w");
		const asst = (text: string): UIMessage => ({
			id: `a-${text}`,
			role: "assistant",
			parts: [{ type: "text", text }],
		});
		// Arrival order: all three questions, then the reply — a message
		// that lands mid-turn sits ahead of a response it never saw.
		store.append(c.id, [msg("2+2?"), msg("2+5?"), msg("2+8?")]);
		store.append(c.id, [asst("4.")], { anchorSeq: 1 });
		const h = store.history(c.id);
		expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
		expect((h[0]!.parts[0] as { text: string }).text).toBe("2+2?");
		expect((h[1]!.parts[0] as { text: string }).text).toBe("4.");
		expect((h[2]!.parts[0] as { text: string }).text).toBe("2+5?");
		expect(store.lastUserSeq(c.id)).toBe(3);
		store.close();
	});

	test("unanchored events keep pure arrival order", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 42 }, "/w");
		store.append(c.id, [msg("one"), msg("two")]);
		store.append(c.id, [
			{ id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
		]);
		expect(store.history(c.id).map((m) => m.role)).toEqual([
			"user",
			"user",
			"assistant",
		]);
		store.close();
	});

	test("a pre-anchor DB migrates in place — old rows read, new anchors work", () => {
		const path = tmpdb();
		// Hand-build the old schema: events without anchor_seq.
		const old = new Database(path);
		old.run(`CREATE TABLE conversations (
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
		old.run(`CREATE TABLE events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			data TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(conversation_id, seq)
		)`);
		old.run(
			`INSERT INTO conversations (id, chat_id, cwd, created_at) VALUES ('dm:9', 9, '/w', 't')`,
		);
		old.run(
			`INSERT INTO events (conversation_id, seq, role, data, created_at) VALUES
				('dm:9', 1, 'user', ?, 't'),
				('dm:9', 2, 'assistant', ?, 't')`,
			[
				JSON.stringify(msg("old question")),
				JSON.stringify({ id: "a0", role: "assistant", parts: [{ type: "text", text: "old reply" }] }),
			],
		);
		old.close();

		const store = openStore(path);
		// Old rows survived and keep arrival order (null anchor → seq).
		expect(store.history("dm:9").map((m) => m.role)).toEqual(["user", "assistant"]);
		// New anchored writes interleave against migrated rows.
		store.append("dm:9", [msg("follow-up")]);
		store.append(
			"dm:9",
			[{ id: "a1", role: "assistant", parts: [{ type: "text", text: "new reply" }] }],
			{ anchorSeq: store.lastUserSeq("dm:9") },
		);
		expect(store.history("dm:9").map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		store.close();
	});

	test("bumpEpoch advances monotonically and persists", () => {
		const path = tmpdb();
		const store = openStore(path);
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		expect(store.bumpEpoch(c.id)).toBe(1);
		expect(store.bumpEpoch(c.id)).toBe(2);
		store.close();
		const reopened: ConversationStore = openStore(path);
		expect(reopened.get(c.id)?.epoch).toBe(2);
		reopened.close();
	});

	test("applySettings patches meta and bumps epoch atomically", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		expect(store.applySettings(c.id, { model: "zai/glm-4.5", voice: true })).toBe(1);
		const after = store.get(c.id)!;
		expect(after.model).toBe("zai/glm-4.5");
		expect(after.voice).toBe(true);
		expect(after.epoch).toBe(1);
		store.close();
	});

	test("history degrades a corrupt row to a placeholder instead of failing", () => {
		const path = tmpdb();
		const store = openStore(path);
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		// Corrupt disk state — bypass the store's own writer.
		const db = new Database(path);
		db.run(
			"INSERT INTO events (conversation_id, seq, role, data, created_at) VALUES (?, ?, ?, ?, ?)",
			[c.id, 1, "user", JSON.stringify({ bogus: true }), new Date().toISOString()],
		);
		db.close();
		const h = store.history(c.id);
		expect(h).toHaveLength(1);
		expect(h[0]!.role).toBe("user");
		expect((h[0]!.parts[0] as { text: string }).text).toContain("unreadable history row");
		// The conversation stays usable — later turns read past the row.
		store.append(c.id, [msg("still here")]);
		expect(store.history(c.id)).toHaveLength(2);
		store.close();
	});

	test("titleImplicit flag round-trips through setMeta", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "topic", chatId: 42, threadId: 7 }, "/w");
		expect(c.titleImplicit).toBe(false);
		store.setMeta(c.id, { title: "New Chat", titleImplicit: true });
		expect(store.get(c.id)!.titleImplicit).toBe(true);
		store.setMeta(c.id, { title: "real name", titleImplicit: false });
		const after = store.get(c.id)!;
		expect(after.title).toBe("real name");
		expect(after.titleImplicit).toBe(false);
		store.close();
	});

	test("setMeta patches fields", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.setMeta(c.id, { model: "zai/glm-4.6", thinking: "high" });
		const after = store.get(c.id)!;
		expect(after.model).toBe("zai/glm-4.6");
		expect(after.thinking).toBe("high");
		store.setMeta(c.id, { model: null });
		expect(store.get(c.id)!.model).toBeNull();
		store.close();
	});
});

describe("history payload envelope", () => {
	test("append writes versioned envelopes that read back intact", () => {
		const path = tmpdb();
		const store = openStore(path);
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("one")]);
		store.close();
		const raw = new Database(path)
			.query<{ data: string }, []>("SELECT data FROM events")
			.all()[0]!.data;
		const parsed = JSON.parse(raw) as { v?: number; message?: UIMessage };
		expect(parsed.v).toBe(1);
		expect(parsed.message!.parts[0]).toMatchObject({ type: "text", text: "one" });
	});

	test("bare legacy rows still read, and are wrapped once at next open", () => {
		const path = tmpdb();
		const store = openStore(path);
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("legacy")]);
		// Forcibly age the row back to the pre-envelope format.
		store.db.run("UPDATE events SET data = json_extract(data, '$.message')");
		expect(store.history(c.id).map((m) => (m.parts[0] as { text: string }).text)).toEqual(["legacy"]);
		store.close();
		// Migration at open: wrap, and never re-wrap (idempotent).
		const reopened = openStore(path);
		expect(reopened.history(c.id).map((m) => (m.parts[0] as { text: string }).text)).toEqual(["legacy"]);
		const raw = reopened.db.query<{ data: string }, []>("SELECT data FROM events").all()[0]!.data;
		expect(JSON.parse(raw)).toMatchObject({ v: 1 });
		reopened.close();
		const twice = openStore(path);
		expect(JSON.parse(twice.db.query<{ data: string }, []>("SELECT data FROM events").all()[0]!.data)).toMatchObject({ v: 1 });
		twice.close();
	});
	test("a corrupt bare row is left unmigrated and still placeholder-degrades", () => {
		const path = tmpdb();
		const store = openStore(path);
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("good")]);
		store.db.run(
			`INSERT INTO events (conversation_id, seq, role, data, anchor_seq, created_at) VALUES (?, 2, 'user', 'not json at all', NULL, ?)`,
			[c.id, new Date().toISOString()],
		);
		store.close();
		const reopened = openStore(path);
		const h = reopened.history(c.id);
		expect(h).toHaveLength(2);
		expect((h[1]!.parts[0] as { text: string }).text).toContain("unreadable history row");
		reopened.close();
	});
});

describe("compaction pointers", () => {
	test("getCompaction returns the latest row; modelEntries is summary + tail", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("one"), { id: "a", role: "assistant", parts: [{ type: "text", text: "two" }] }]);
		store.append(c.id, [msg("three")]);
		store.setCompaction(c.id, {
			boundarySeq: 2,
			summary: "the early era, folded",
			tokensBefore: 1234,
			model: "zai/glm-5.3",
			createdAt: "2026-01-01T00:00:00Z",
		});
		store.setCompaction(c.id, {
			boundarySeq: 2,
			summary: "newer fold",
			tokensBefore: 2345,
			model: "zai/glm-5.3",
			createdAt: "2026-01-02T00:00:00Z",
		});
		expect(store.getCompaction(c.id)).toMatchObject({ boundarySeq: 2, summary: "newer fold" });
		// The full record stays whole; the model view is cut and lead by
		// the synthetic summary message.
		expect(store.history(c.id)).toHaveLength(3);
		const view = store.modelEntries(c.id);
		expect(view).toHaveLength(2);
		expect(view[0]!.seq).toBe(2);
		expect(view[0]!.message.role).toBe("user");
		expect((view[0]!.message.parts[0] as { text: string }).text).toContain("newer fold");
		expect(view[0]!.message.id).toBe("compact-2");
		expect((view[1]!.message.parts[0] as { text: string }).text).toBe("three");
		store.close();
	});

	test("a late answer to a folded question rides into the summary — never orphaned in the tail", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		// Interleaved burst (arrival order): a question, three more while
		// its turn ran, then the answer — high seq, anchored to seq 1.
		store.append(c.id, [msg("first")]); // seq 1
		store.append(c.id, [msg("barge-1"), msg("barge-2"), msg("barge-3")]); // 2-4
		store.append(
			c.id,
			[{ id: "a1", role: "assistant", parts: [{ type: "text", text: "the answer" }] }],
			{ anchorSeq: 1 },
		); // seq 5, causal position 1
		store.setCompaction(c.id, {
			boundarySeq: 3,
			summary: "folded",
			tokensBefore: 100,
			model: "m",
			createdAt: "2026-01-01T00:00:00Z",
		});
		// The answer's causal position precedes the boundary, so the
		// summary covers it — filtering on raw seq would strand it in the
		// tail, orphaned from the question the summary just replaced.
		const view = store.modelEntries(c.id);
		expect(view.map((e) => e.seq)).toEqual([3, 4]);
		expect(view[0]!.message.id).toBe("compact-3");
		store.close();
	});

	test("without a pointer, modelEntries is exactly the causal view", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("one")]);
		expect(store.modelEntries(c.id)).toEqual(store.historyEntries(c.id));
		store.close();
	});
});

describe("chat search", () => {
	const asst = (id: string, text: string): UIMessage => ({
		id,
		role: "assistant",
		parts: [{ type: "text", text }],
	});

	test("finds user and assistant text across conversations, bounded by limit", () => {
		const store = openStore(tmpdb());
		const a = store.resolve({ kind: "topic", chatId: -100, threadId: 7 }, "/w");
		const b = store.resolve({ kind: "dm", chatId: 42 }, "/w");
		store.setMeta(a.id, { title: "Pizza plans" });
		store.append(a.id, [msg("we decided pineapple belongs on pizza")]);
		store.append(b.id, [asst("a1", "the pineapple decision stands")]);
		store.append(a.id, [msg("unrelated weather chat")]);
		const hits = store.searchHistory("pineapple", 10);
		expect(hits.map((h) => h.conversationId).sort()).toEqual([a.id, b.id].sort());
		expect(hits.find((h) => h.conversationId === a.id)).toMatchObject({
			title: "Pizza plans",
			seq: 1,
			role: "user",
		});
		expect(hits.find((h) => h.conversationId === a.id)!.text).toContain("pineapple");
		expect(store.searchHistory("pineapple", 1)).toHaveLength(1);
		expect(store.searchHistory("weather", 10)).toHaveLength(1);
		store.close();
	});

	test("tool payloads and system events are never indexed", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [{
			id: "t1",
			role: "assistant",
			parts: [{ type: "tool-zebracakesecret", input: "zebracakesecret payload" } as unknown as UIMessage["parts"][number]],
		}]);
		store.append(c.id, [{
			id: "s1",
			role: "system",
			parts: [{ type: "text", text: "system note about zebracakesecret" }],
		}]);
		expect(store.searchHistory("zebracakesecret", 10)).toEqual([]);
		store.close();
	});

	test("memory exclusion hides retroactively", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("the retroactive hiddenword plans")]);
		expect(store.searchHistory("hiddenword", 10)).toHaveLength(1);
		store.setMeta(c.id, { memoryExcluded: true });
		expect(store.searchHistory("hiddenword", 10)).toEqual([]);
		store.setMeta(c.id, { memoryExcluded: false });
		expect(store.searchHistory("hiddenword", 10)).toHaveLength(1);
		store.close();
	});

	test("deletes stay honest through the delete trigger", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("the transient forgetmeword note")]);
		expect(store.searchHistory("forgetmeword", 10)).toHaveLength(1);
		store.db.run("DELETE FROM events WHERE conversation_id = ?", [c.id]);
		expect(store.searchHistory("forgetmeword", 10)).toEqual([]);
		store.close();
	});

	test("upgrading DBs backfill the index at open", () => {
		const path = tmpdb();
		const first = openStore(path);
		const c = first.resolve({ kind: "dm", chatId: 1 }, "/w");
		first.append(c.id, [msg("the backfill checkword plans")]);
		first.close();
		// Simulate a pre-FTS database: drop the index and its triggers.
		const raw = new Database(path);
		raw.run("DROP TRIGGER IF EXISTS events_fts_ai");
		raw.run("DROP TRIGGER IF EXISTS events_fts_ad");
		raw.run("DROP TRIGGER IF EXISTS events_fts_au");
		raw.run("DROP TABLE events_fts");
		raw.close();
		const second = openStore(path);
		const hits = second.searchHistory("checkword", 10);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.conversationId).toBe(c.id);
		second.close();
	});

	test("query syntax is literal — operators never throw, empties answer empty", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("plain hello world note")]);
		expect(store.searchHistory('" OR *:', 10)).toEqual([]);
		expect(store.searchHistory("   ", 10)).toEqual([]);
		expect(store.searchHistory('"""', 10)).toEqual([]);
		expect(store.searchHistory("hello", 10)).toHaveLength(1);
		store.close();
	});

	test("eventContext pages an arrival-ordered window", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("one"), msg("two"), msg("three"), msg("four"), msg("five")]);
		expect(store.eventContext(c.id, 3, 1).map((r) => r.seq)).toEqual([2, 3, 4]);
		expect(store.eventContext(c.id, 1, 3).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
		expect(store.eventContext(c.id, 99, 3)).toEqual([]);
		const mid = store.eventContext(c.id, 3, 0);
		expect(mid).toHaveLength(1);
		expect(mid[0]!.text).toBe("three");
		store.close();
	});
});

describe("app channel addresses", () => {
	test("addressId serializes an app address to its app/ id", () => {
		expect(addressId(appAddress("chat-01"))).toBe("app/chat-01");
		expect(addressId({ kind: "dm", chatId: 5 })).toBe("dm:5");
		expect(addressId({ kind: "topic", chatId: -100, threadId: 7 })).toBe("topic:-100:7");
	});

	test("channelOf routes on the id prefix — the whole discriminant", () => {
		expect(channelOf("app/chat-01")).toBe("app");
		expect(channelOf("dm:5")).toBe("telegram");
		expect(channelOf("topic:-100:7")).toBe("telegram");
		// A telegram id can never collide: ':' can't follow "app" in the
		// telegram formats, and "/" can't appear in either.
		expect(channelOf("dm:app/1")).toBe("telegram");
	});

	test("malformed app ids are rejected at the boundary, never stored", () => {
		for (const bad of ["", "a b", "a/b", "../x", "-lead", "_lead", "x".repeat(65), "é"]) {
			expect(() => appAddress(bad)).toThrow();
		}
		// The literal path is guarded too — addressId revalidates.
		expect(() =>
			addressId({ kind: "app", appId: "a/b", chatId: 0, threadId: 0 }),
		).toThrow();
	});
});

describe("app channel store", () => {
	test("resolve creates an app conversation with no telegram coordinates", () => {
		const store = openStore(tmpdb());
		const a = store.resolve(appAddress("chat-01"), "/w");
		expect(a.id).toBe("app/chat-01");
		expect(a.chatId).toBe(0);
		expect(a.threadId).toBeNull();
		expect(a.epoch).toBe(0);
		const b = store.resolve(appAddress("chat-01"), "/other");
		expect(b.id).toBe(a.id);
		store.close();
	});

	test("app and telegram pools never mix in the same store", () => {
		const store = openStore(tmpdb());
		const tg = store.resolve({ kind: "dm", chatId: 42 }, "/w");
		const app = store.resolve(appAddress("chat-01"), "/w");
		expect(store.listAppConversations().map((c) => c.id)).toEqual([app.id]);
		expect(channelOf(tg.id)).toBe("telegram");
		expect(channelOf(app.id)).toBe("app");
		// Histories are disjoint — writes on one side never cross.
		store.append(app.id, [msg("app side")]);
		store.append(tg.id, [msg("telegram side")]);
		expect(store.history(app.id).map((m) => (m.parts[0] as { text: string }).text)).toEqual(["app side"]);
		expect(store.history(tg.id).map((m) => (m.parts[0] as { text: string }).text)).toEqual(["telegram side"]);
		store.close();
	});

	test("listAppConversations: newest activity first, preview off the last event", () => {
		const store = openStore(tmpdb());
		const idle = store.resolve(appAddress("chat-01"), "/w");
		const active = store.resolve(appAddress("chat-02"), "/w");
		expect(store.listAppConversations().map((c) => c.id)).toEqual([idle.id, active.id]);
		store.append(active.id, [msg("latest app exchange")]);
		const list = store.listAppConversations();
		expect(list[0]!.id).toBe(active.id);
		expect(list[0]!.preview).toBe("latest app exchange");
		expect(list[0]!.updatedAt >= list[0]!.createdAt).toBe(true);
		expect(list[1]!.id).toBe(idle.id);
		expect(list[1]!.preview).toBe("");
		store.close();
	});
});
