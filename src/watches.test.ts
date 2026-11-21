import { describe, expect, test } from "bun:test";
import { openStore } from "./conversation.ts";
import { openWakeStore } from "./wake-store.ts";
import { makeWatches } from "./watches.ts";

describe("watches store", () => {
	test("adds, lists and cancels only within the conversation; caps active rows", () => {
		const store = openStore(":memory:");
		try {
			const first = store.resolve({ kind: "dm", chatId: 11 }, "/tmp");
			const second = store.resolve({ kind: "dm", chatId: 12 }, "/tmp");
			const watches = makeWatches(store.db, () => new Date("2026-11-21T00:00:00.000Z"));
			const row = watches.add({
				conversationId: first.id,
				target: { kind: "time", at: "2026-11-21T01:00:00.000Z" },
				reason: "test",
				baseline: { at: "2026-11-21T01:00:00.000Z" },
			});
			expect(watches.forConversation(first.id).map((w) => w.id)).toEqual([row.id]);
			expect(watches.cancel(row.id, second.id)).toBe(false);
			expect(watches.cancel(row.id, first.id)).toBe(true);
			for (let i = 0; i < 32; i++) {
				watches.add({
					conversationId: second.id,
					target: { kind: "time", at: "2026-11-22T00:00:00.000Z" },
					reason: "cap",
					baseline: { at: "2026-11-22T00:00:00.000Z" },
				});
			}
			expect(() => watches.add({
				conversationId: second.id,
				target: { kind: "time", at: "2026-11-22T00:00:00.000Z" },
				reason: "cap",
				baseline: { at: "2026-11-22T00:00:00.000Z" },
			})).toThrow("at most 32");
		} finally {
			store.close();
		}
	});

	test("fire is idempotent and records one development", () => {
		const store = openStore(":memory:");
		try {
			const conv = store.resolve({ kind: "dm", chatId: 13 }, "/tmp");
			const watches = makeWatches(store.db, () => new Date("2026-11-21T00:00:00.000Z"));
			const wakes = openWakeStore(store.db);
			const row = watches.add({
				conversationId: conv.id,
				target: { kind: "time", at: "2026-11-21T01:00:00.000Z" },
				reason: "test",
				baseline: { at: "2026-11-21T01:00:00.000Z" },
			});
			const development = {
				conversationId: conv.id,
				text: "[watch fired] test",
				facts: {},
				origin: "watch",
			};
			expect(watches.fire(row.id, wakes, development)).toBe(true);
			expect(watches.fire(row.id, wakes, development)).toBe(false);
			expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_events").get()?.n).toBe(1);
		} finally {
			store.close();
		}
	});

	test("conversation deletion removes its watches", () => {
		const store = openStore(":memory:");
		try {
			const conv = store.resolve({ kind: "dm", chatId: 14 }, "/tmp");
			const watches = makeWatches(store.db);
			const watch = watches.add({
				conversationId: conv.id,
				target: { kind: "time", at: "2026-11-22T00:00:00.000Z" },
				reason: "delete test",
				baseline: { at: "2026-11-22T00:00:00.000Z" },
			});
			store.deleteConversation(conv.id);
			expect(watches.get(watch.id)).toBeNull();
		} finally {
			store.close();
		}
	});
});
