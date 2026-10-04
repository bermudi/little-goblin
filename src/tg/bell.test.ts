// The bell's boundary contract (design/app.md → Spin-off → Telegram
// rings): a finished app background turn pings every allowed operator
// once — deep-link button only with a publicUrl — records the ping so
// swipe-replies route back, and journals the ping text into each
// operator's current DM. Fenced turns are silent; one wedged send
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
}): Harness {
	const store = openStore(tmpdb());
	const sent: Sent[] = [];
	const pings = openPings(store.db);
	const api = {
		sendMessage: (chat: number, text: string, options?: { reply_markup?: unknown }) => {
			if (opts.failChats?.includes(chat)) {
				return Promise.reject(new Error("chat deleted"));
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
		},
	};
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
		sink.onTextDelta("deployed   the thing\nand all tests pass");
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

	test("no publicUrl — the ping carries text only, never a button", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		sink.onTextDelta("done");
		await sink.onDone({ kind: "completed" });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.markup).toBeUndefined();
		h.store.close();
	});

	test("the reply head is whitespace-collapsed and cut at 200 chars", async () => {
		const h = harness({ allowedUsers: [1] });
		const conv = appConv(h.store);
		const sink = makeBellSink(h.deps, conv);
		sink.onTextDelta("x".repeat(300));
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
		sink.onTextDelta("done");
		await sink.onDone({ kind: "completed" });
		expect(h.sent.map((s) => s.chat)).toEqual([7]);
		expect(h.pings.lookup(7, 1001)).toBe(conv.id);
		h.store.close();
	});
});
