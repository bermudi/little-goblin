import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore, type ConversationStore } from "../conversation.ts";
import { fakeApi as fakeTelegramApi } from "../testkit/fake-api.ts";
import type { DeliveryApi } from "./delivery.ts";
import { openPings } from "./pings.ts";
import { makeBellSink, type BellDeps } from "./bell.ts";
import { tmpDb } from "../testkit.ts";

interface Sent {
	chat: number;
	text: string;
	markup?: unknown;
}

interface Harness {
	deps: BellDeps;
	store: ConversationStore;
	sent: Sent[];
	pings: ReturnType<typeof openPings>;
}

function harness(opts: {
	allowedUsers: number[];
	publicUrl?: string;
	failChats?: number[];
	hangChats?: number[];
	timeoutMs?: number;
}): Harness {
	const store = openStore(tmpDb("goblin-bell-"));
	const sent: Sent[] = [];
	const pings = openPings(store.db);
	const api = fakeTelegramApi({
		handlers: {
			sendMessage: (chat: number, text: string, options?: { reply_markup?: unknown }) => {
				if (opts.failChats?.includes(chat)) {
					return Promise.reject(new Error("chat deleted"));
				}
				if (opts.hangChats?.includes(chat)) {
					return new Promise(() => {});
				}
				sent.push({ chat, text, markup: options?.reply_markup });
				return Promise.resolve({ message_id: 1000 + sent.length });
			},
		},
	}).api as unknown as DeliveryApi;
	return {
		store,
		sent,
		pings,
		deps: {
			api,
			store,
			pings,
			operators: () => opts.allowedUsers,
			publicUrl: () => opts.publicUrl,
			...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
		},
	};
}

// The dedupe set is module-level and every fork shares the "spun-1"
// app id — reply ids must be unique per test.
let replySeq = 0;
function reply(store: ConversationStore, convId: string, text: string): string {
	const id = `asst-${++replySeq}`;
	store.append(convId, [{ id, role: "assistant", parts: [{ type: "text", text }] }]);
	return id;
}

function appConv(store: ConversationStore, title = "the work") {
	return store.forkToApp(store.resolve({ kind: "dm", chatId: 1 }, "/w").id, "spun-1", "/w", title);
}

describe("makeBellSink", () => {
	test("a completed turn pings every allowed user with the deep-link button", async () => {
		const h = harness({ allowedUsers: [1, 7], publicUrl: "https://g.example/" });
		const conv = appConv(h.store);
		h.store.rollDm(1, "/w");
		h.store.rollDm(7, "/w");
		const sink = makeBellSink(h.deps, conv);
		reply(h.store, conv.id, "deployed   the thing\nand all tests pass");
		await sink.onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([1, 7]);
		expect(h.sent[0]!.text).toBe("the work: deployed the thing and all tests pass");
		// Trailing-slash hosts normalize.
		expect(h.sent[0]!.markup).toEqual({
			inline_keyboard: [[{ text: "Open in app", url: "https://g.example/app/c/spun-1" }]],
		});
		expect(h.pings.lookup(1, 1001)).toBe(conv.id);
		expect(h.pings.lookup(7, 1002)).toBe(conv.id);
		const dm = h.store.currentDm(1)!;
		const journaled = h.store.history(dm.id).at(-1)!;
		expect(journaled.role).toBe("assistant");
		expect((journaled.parts[0] as { text: string }).text).toBe(h.sent[0]!.text);
		h.store.close();
	});

	test("a bell that merged behind another head still pings the stored reply", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		reply(h.store, conv.id, "the real answer");
		await sink.onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([1]);
		expect(h.sent[0]!.text).toBe("the work: the real answer");
		h.store.close();
	});

	test("two bells on one response ring once — the second is a dup", async () => {
		const h = harness({ allowedUsers: [1, 7] });
		const conv = appConv(h.store);
		reply(h.store, conv.id, "shipped");
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([1, 7]);
		h.store.close();
	});

	test("a ping that reaches nobody stays unpinged — the next bell retries", async () => {
		// failChats is read per send — emptying it mid-test ends the
		// simulated outage.
		const failChats = [1];
		const h = harness({ allowedUsers: [1], failChats });
		const conv = appConv(h.store);
		reply(h.store, conv.id, "done");
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent).toEqual([]);
		failChats.length = 0;
		// All sends failed, so the dedup key was not consumed — a second
		// bell for the same response still rings.
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([1]);
		h.store.close();
	});

	test("a completed turn with no stored reply pings nobody", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent).toEqual([]);
		h.store.close();
	});

	test("no publicUrl — the ping carries text only, never a button", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		reply(h.store, conv.id, "done");
		await sink.onDone({ kind: "completed" });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.markup).toBeUndefined();
		h.store.close();
	});

	test("the reply head is whitespace-collapsed and cut at 200 chars", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		reply(h.store, conv.id, "x".repeat(300));
		await sink.onDone({ kind: "completed" });
		expect(h.sent[0]!.text).toBe(`the work: ${"x".repeat(200)}…`);
		h.store.close();
	});

	test("a turn error rings a failure ping", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		await sink.onDone({ kind: "error", message: "model exploded" });
		expect(h.sent[0]!.text).toBe("the work: the turn failed — model exploded");
		h.store.close();
	});

	test("a deleted app conversation degrades to the generic label, no button", async () => {
		// A deleted conversation must not ride the captured stale title
		// nor deep-link into a dead conversation.
		const h = harness({ allowedUsers: [1], publicUrl: "https://g.example/" });
		const conv = appConv(h.store);
		h.store.deleteConversation(conv.id);
		await makeBellSink(h.deps, conv).onDone({ kind: "error", message: "model exploded" });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.text).toBe("app conversation: the turn failed — model exploded");
		expect(h.sent[0]!.markup).toBeUndefined();
		h.store.close();
	});

	test("a fenced turn rings nobody", async () => {
		const h = harness({ allowedUsers: [1] });
		const sink = makeBellSink(h.deps, appConv(h.store));
		await sink.onDone({ kind: "fenced" });
		expect(h.sent).toEqual([]);
		h.store.close();
	});

	test("one wedged send logs and never silences the other chats", async () => {
		const h = harness({ allowedUsers: [1, 7], failChats: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		reply(h.store, conv.id, "done");
		await sink.onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([7]);
		expect(h.pings.lookup(7, 1001)).toBe(conv.id);
		h.store.close();
	});

	test("bookkeeping failure after a landed ping keeps the dedup key", async () => {
		// Dedup keys on the send landing, not on bookkeeping — a record
		// failure after delivery must not let a second bell re-ring.
		const h = harness({ allowedUsers: [1, 7] });
		const conv = appConv(h.store);
		reply(h.store, conv.id, "done");
		const realRecord = h.pings.record.bind(h.pings);
		h.pings.record = () => {
			throw new Error("ping store wedged");
		};
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([1, 7]);
		h.pings.record = realRecord;
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent).toHaveLength(2);
		h.store.close();
	});

	test("a hung send times out: nothing recorded, the next chat still rings", async () => {
		const h = harness({ allowedUsers: [1, 7], hangChats: [1], timeoutMs: 30 });
		const conv = appConv(h.store);
		h.store.rollDm(1, "/w");
		const sink = makeBellSink(h.deps, conv);
		reply(h.store, conv.id, "done");
		await sink.onDone({ kind: "completed" });
		// The timed-out send left no message id — no record, no journal.
		expect(h.sent.map((s) => s.chat)).toEqual([7]);
		expect(h.pings.lookup(7, 1001)).toBe(conv.id);
		expect(h.store.history(h.store.currentDm(1)!.id)).toHaveLength(0);
		h.store.close();
	});
});
