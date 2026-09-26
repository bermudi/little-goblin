import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { addressId, openStore, type ConversationStore } from "./conversation.ts";

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

	test("without a pointer, modelEntries is exactly the causal view", () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("one")]);
		expect(store.modelEntries(c.id)).toEqual(store.historyEntries(c.id));
		store.close();
	});
});
