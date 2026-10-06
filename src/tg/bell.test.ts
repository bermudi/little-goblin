// The bell's boundary contract (design/app.md → Spin-off → Telegram
// rings): a finished app background turn pings every allowed operator
// once — deep-link button only with a publicUrl — records the ping so
// swipe-replies route back, and journals the ping text into each
// operator's current DM. The summary is the stored assistant reply,
// not the sink's own deltas, and one response pings once however many
// bells its turn carried. Fenced turns are silent; one wedged send
// never silences the rest. Fake Telegram API at the edge, real store.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ConversationStore } from "../conversation.ts";
import type { DeliveryApi } from "./delivery.ts";
import { openPings } from "./pings.ts";
import { makeBellSink, type BellDeps } from "./bell.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-bell-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}

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
	const store = openStore(tmpdb());
	const sent: Sent[] = [];
	const pings = openPings(store.db);
	const api = {
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
		sendChatAction: () => Promise.resolve(true),
	} as unknown as DeliveryApi;
	return {
		store,
		sent,
		pings,
		deps: {
			api,
			store,
			pings,
			allowedUsers: () => opts.allowedUsers,
			publicUrl: () => opts.publicUrl,
			...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
		},
	};
}

// The dedupe set is module-level — every test's fork shares the
// "spun-1" app id, so reply ids must be unique per test.
let replySeq = 0;
function reply(store: ConversationStore, convId: string, text: string): string {
	const id = `asst-${++replySeq}`;
	store.append(convId, [{ id, role: "assistant", parts: [{ type: "text", text }] }]);
	return id;
}

function appConv(store: ConversationStore, title = "the work") {
	return store.forkToApp(
		store.resolve({ kind: "dm", chatId: 1 }, "/w").id,
		"spun-1",
		"/w",
		title,
	);
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
		// Trailing-slash hosts normalize; the button rides every ping.
		expect(h.sent[0]!.markup).toEqual({
			inline_keyboard: [
				[{ text: "Open in app", url: "https://g.example/app/c/spun-1" }],
			],
		});
		// Recorded for reply routing and journaled into each current DM.
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
		// No deltas ever reached this sink — the stored message is it.
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
		// failChats is read per send, so emptying it mid-test is a
		// Telegram outage ending.
		const failChats = [1];
		const h = harness({ allowedUsers: [1], failChats });
		const conv = appConv(h.store);
		reply(h.store, conv.id, "done");
		await makeBellSink(h.deps, conv).onDone({ kind: "completed" });
		expect(h.sent).toEqual([]);
		failChats.length = 0;
		// Every send failed — the dedup key wasn't consumed, so a second
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
