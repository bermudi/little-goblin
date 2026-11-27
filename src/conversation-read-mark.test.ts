import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Message } from "./message.ts";
import { appAddress } from "./conversation-address.ts";
import { openStore } from "./conversation.ts";
import { tmpDb } from "./testkit.ts";

const user = (id: string): Message => ({ id, role: "user", parts: [{ type: "text", text: id }] });
const assistant = (id: string): Message => ({
	id,
	role: "assistant",
	parts: [{ type: "text", text: id }],
});

describe("conversation read marks", () => {
	test("migration stamps existing replies once, then new replies remain unread", () => {
		const path = tmpDb("goblin-read-migration-");
		const first = openStore(path);
		const chat = first.resolve(appAddress("migration"), "/w");
		first.append(chat.id, [assistant("old")]);
		first.close();
		const legacy = new Database(path);
		legacy.run("ALTER TABLE conversations DROP COLUMN read_seq");
		legacy.close();
		const migrated = openStore(path);
		expect(migrated.listAppConversations()[0]?.newReply).toBeNull();
		migrated.close();
		const append = openStore(path);
		append.append(chat.id, [assistant("new")]);
		append.close();
		const reopened = openStore(path);
		expect(reopened.listAppConversations()[0]?.newReply).toBe(2);
		reopened.close();
	});

	test("marks move monotonically, clamp to existing seqs, and expose only newer assistant replies", () => {
		const store = openStore(tmpDb("goblin-read-life-"));
		const chat = store.resolve(appAddress("life"), "/w");
		store.append(chat.id, [user("u1")]);
		expect(store.listAppConversations()[0]?.newReply).toBeNull();
		store.append(chat.id, [assistant("a1")]);
		expect(store.listAppConversations()[0]?.newReply).toBe(2);
		expect(store.markRead(chat.id, 2)).toBe(true);
		expect(store.listAppConversations()[0]?.newReply).toBeNull();
		store.append(chat.id, [assistant("a2")]);
		expect(store.markRead(chat.id, 1)).toBe(false);
		expect(store.listAppConversations()[0]?.newReply).toBe(3);
		expect(store.markRead(chat.id, 9_999_999)).toBe(true);
		expect(store.listAppConversations()[0]?.newReply).toBeNull();
		store.append(chat.id, [assistant("a3")]);
		expect(store.listAppConversations()[0]?.newReply).toBe(4);
		store.close();
	});

	test("a reply appended after the read view stays unread", () => {
		const store = openStore(tmpDb("goblin-read-race-"));
		const chat = store.resolve(appAddress("race"), "/w");
		store.append(chat.id, [assistant("first")]);
		const before = store.listAppConversations()[0]!.newReply!;
		store.append(chat.id, [assistant("second")]);
		store.markRead(chat.id, before);
		expect(store.listAppConversations()[0]?.newReply).toBe(before + 1);
		store.close();
	});

	test("subagent replies never appear as operator unread replies", () => {
		const store = openStore(tmpDb("goblin-read-child-"));
		const parent = store.resolve(appAddress("parent"), "/w");
		const child = store.resolveAgentChild(
			parent,
			"test",
			"task",
			{ model: "zai/m", thinking: "medium" },
			new Date().toISOString(),
		);
		store.append(child.id, [assistant("child reply")]);
		expect(store.listAppConversations().find((row) => row.id === child.id)?.newReply).toBeNull();
		store.close();
	});

	test("whole and cut forks are born read without moving the source mark", () => {
		const store = openStore(tmpDb("goblin-read-fork-"));
		const source = store.resolve(appAddress("source"), "/w");
		store.append(source.id, [user("u1"), assistant("a1"), user("u2"), assistant("a2")]);
		const full = store.forkToApp(source.id, "full", "/w", "full");
		const cut = store.forkToApp(source.id, "cut", "/w", "cut", undefined, { throughSeq: 2 });
		expect(store.listAppConversations().find((row) => row.id === full.id)?.newReply).toBeNull();
		expect(store.listAppConversations().find((row) => row.id === cut.id)?.newReply).toBeNull();
		expect(store.listAppConversations().find((row) => row.id === source.id)?.newReply).toBe(4);
		store.append(full.id, [assistant("fork reply")]);
		expect(store.listAppConversations().find((row) => row.id === full.id)?.newReply).toBe(5);
		store.close();
	});

	test("rolling summaries expose and clear new replies", () => {
		const store = openStore(tmpDb("goblin-read-roll-"));
		const rolling = store.rollApp({
			model: "zai/m",
			thinking: "medium",
			providers: { zai: { kind: "openai-compatible", baseUrl: "https://example.com", auth: "zai" } },
		} as never);
		store.append(rolling.id, [assistant("roll reply")]);
		expect(store.appRollChain(1)[0]?.newReply).toBe(1);
		store.markRead(rolling.id, 1);
		expect(store.appRollChain(1)[0]?.newReply).toBeNull();
		store.close();
	});

	test("rewind removes unread reply and later reply receives a fresh seq", () => {
		const store = openStore(tmpDb("goblin-read-rewind-"));
		const chat = store.resolve(appAddress("rewind"), "/w");
		store.append(chat.id, [user("question"), assistant("reply")]);
		expect(store.listAppConversations()[0]?.newReply).toBe(2);
		store.editUserMessage(chat.id, "question", user("question-edit"));
		expect(store.listAppConversations()[0]?.newReply).toBeNull();
		store.append(chat.id, [assistant("next")]);
		expect(store.listAppConversations()[0]?.newReply).toBe(4);
		store.close();
	});

	test("memoized event summaries do not cache read state and match a fresh store", () => {
		const path = tmpDb("goblin-read-memo-");
		const store = openStore(path);
		const chat = store.resolve(appAddress("memo"), "/w");
		store.append(chat.id, [assistant("reply")]);
		const before = store.listAppConversations();
		expect(before[0]?.newReply).toBe(1);
		store.markRead(chat.id, 1);
		expect(store.listAppConversations()[0]?.newReply).toBeNull();
		const fresh = openStore(path);
		expect(store.listAppConversations()).toEqual(fresh.listAppConversations());
		fresh.close();
		store.close();
	});
});
