import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { makeAsks } from "./asks.ts";

function rig() {
	const db = new Database(":memory:");
	db.run("CREATE TABLE conversations (id TEXT PRIMARY KEY, archived_at TEXT)");
	db.run("CREATE TABLE app_rolls (n INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL)");
	db.run(`CREATE TABLE asks (
		id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, question TEXT NOT NULL,
		options TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, operator_only INTEGER NOT NULL DEFAULT 0,
		closed_by TEXT CHECK (closed_by IN ('goblin','tap','dismiss'))
	)`);
	for (const id of ["app/one", "app/two", "app/three", "app/archived"]) {
		db.query("INSERT INTO conversations (id, archived_at) VALUES (?, NULL)").run(id);
	}
	db.run("UPDATE conversations SET archived_at = '2026-01-01' WHERE id = 'app/archived'");
	const asks = makeAsks(db, () => new Date("2026-11-22T08:00:00.000Z"));
	return { db, asks };
}

function opened(result: ReturnType<ReturnType<typeof makeAsks>["open"]>) {
	if ("error" in result) throw new Error(result.error);
	return result;
}

test("asks open, list oldest first, close, and refuse invalid questions or options", () => {
	const { db, asks } = rig();
	const first = opened(asks.open({ conversationId: "app/one", question: "  Pick a time? ", options: [" 9:00 ", "11:00"] }));
	const second = opened(asks.open({ conversationId: "app/one", question: "Second?" }));
	expect(first).toMatchObject({ id: 1, question: "Pick a time?", options: ["9:00", "11:00"] });
	expect(asks.listOpen("app/one").map((ask) => ask.id)).toEqual([1, 2]);
	expect(asks.close(1, "goblin", "app/one")).toBe("closed");
	expect(asks.close(1, "tap", "app/one")).toBe("already");
	expect(asks.listOpen("app/one").map((ask) => ask.id)).toEqual([2]);
	expect(asks.close(1000, "dismiss")).toBe("missing");
	for (const input of [
		{ question: "Q", options: ["one"] },
		{ question: "Q", options: ["1", "2", "3", "4", "5"] },
		{ question: "Q", options: ["same", " same "] },
		{ question: "x".repeat(501) },
		{ question: "  " },
	]) {
		expect(asks.open({ conversationId: "app/three", ...input } as Parameters<typeof asks.open>[0])).toHaveProperty("error");
	}
	db.close();
});

test("the tenth open question is allowed and the eleventh says to close one first", () => {
	const { db, asks } = rig();
	for (let index = 0; index < 10; index += 1) {
		expect(asks.open({ conversationId: "app/one", question: `Question ${index}` })).not.toHaveProperty("error");
	}
	expect(asks.open({ conversationId: "app/one", question: "Too many" })).toMatchObject({ error: expect.stringContaining("Close one first") });
	const required = asks.openRequired({ conversationId: "app/one", question: "What should the bot do next?" });
	expect(asks.openForAttention().map((ask) => ask.id)).toContain(required.id);
	expect(asks.close(required.id, "goblin", "app/one")).toBe("out-of-scope");
	expect(asks.close(required.id, "dismiss")).toBe("closed");
	db.close();
});

test("closing respects roll scope but a roll can close an older roll ask", () => {
	const { db, asks } = rig();
	const loose = opened(asks.open({ conversationId: "app/one", question: "Loose" }));
	expect(asks.close(loose.id, "goblin", "app/two")).toBe("out-of-scope");
	db.query("INSERT INTO app_rolls (n, conversation_id) VALUES (1, 'app/one'), (2, 'app/two')").run();
	const rolled = opened(asks.open({ conversationId: "app/one", question: "Earlier roll" }));
	expect(asks.close(rolled.id, "goblin", "app/two")).toBe("closed");
	expect(asks.listOpen("app/two").map((ask) => ask.id)).toEqual([loose.id]);
	db.close();
});

test("attention excludes archived and deleted conversations", () => {
	const { db, asks } = rig();
	asks.open({ conversationId: "app/one", question: "Visible" });
	asks.open({ conversationId: "app/archived", question: "Hidden" });
	const deleted = opened(asks.open({ conversationId: "app/three", question: "Deleted" }));
	db.query("DELETE FROM conversations WHERE id = 'app/three'").run();
	expect(asks.openForAttention().map((ask) => ask.question)).toEqual(["Visible"]);
	expect(asks.close(deleted.id, "dismiss")).toBe("closed");
	db.close();
});
