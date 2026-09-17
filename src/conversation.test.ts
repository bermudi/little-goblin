import { afterEach, describe, expect, test } from "bun:test";
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
		expect(a.cwd).toBe("/w");
		const b = store.resolve({ kind: "topic", chatId: -100, threadId: 7 }, "/other");
		expect(b.id).toBe(a.id);
		expect(b.cwd).toBe("/w"); // cwd is fixed once set
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
		expect(store.applySettings(c.id, { model: "zai/glm-4.5" })).toBe(1);
		const after = store.get(c.id)!;
		expect(after.model).toBe("zai/glm-4.5");
		expect(after.epoch).toBe(1);
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
