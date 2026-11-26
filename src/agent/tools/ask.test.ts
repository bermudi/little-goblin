import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { makeAsks } from "../../asks.ts";
import { ensureConversationSchema } from "../../conversation-schema.ts";
import { askTool } from "./ask.ts";

test("ask tool opens, lists, closes within scope, and refuses missing or out-of-scope questions", async () => {
	const db = new Database(":memory:");
	ensureConversationSchema(db);
	db.query("INSERT INTO conversations (id, chat_id, cwd, created_at) VALUES (?, 0, '/tmp', ?)").run("app/one", "2026-01-01");
	db.query("INSERT INTO conversations (id, chat_id, cwd, created_at) VALUES (?, 0, '/tmp', ?)").run("app/two", "2026-01-01");
	const asks = makeAsks(db, () => new Date("2026-11-22T08:00:00.000Z"));
	const tool = askTool({ asks, conversationId: "app/one" });
	const run = (input: unknown) => tool.execute(input as never, { toolCallId: "ask-test" });
	const opened = await run({ action: "open", question: "When?", options: ["9", "11"] }) as { id: number };
	expect(opened.id).toBe(1);
	expect(await run({ action: "list" })).toMatchObject({
		questions: [{ id: 1, question: "When?", options: ["9", "11"], conversationId: "app/one" }],
	});
	expect(await run({ action: "close", id: 1 })).toEqual({ closed: true });
	expect(await run({ action: "close", id: 1 })).toEqual({ closed: false, note: "already closed" });
	const other = asks.open({ conversationId: "app/two", question: "Private" });
	if ("error" in other) throw new Error(other.error);
	expect(await run({ action: "close", id: other.id })).toEqual({ error: "question is outside this chat" });
	expect(await run({ action: "close", id: 99 })).toEqual({ error: "question not found" });
	expect(tool.description).toBe('Ask the operator a question that waits for an answer. The app shows it as a card in this chat, with up to four buttons if you give options, and marks the chat in the chat list as needing the operator until the question is closed. A button tap sends "[ask] <question> → <label>" as the operator\'s message and closes the question; the operator can also close it with "No answer needed". action "open" asks; "list" shows the open questions of this chat (in the Rolling chat, of every roll); "close" closes one by id — close a question once the operator has answered it in their own words. Only the app shows questions.');
	db.close();
});
