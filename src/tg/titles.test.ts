import { afterEach, describe, expect, test } from "bun:test";
import { fakeApi } from "../testkit/fake-api.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { maybeRenameTopic, titleMetaFromService } from "./titles.ts";

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

describe("titleMetaFromService", () => {
	test("implicit create owes a title; explicit create and edits settle it", () => {
		expect(
			titleMetaFromService({
				forum_topic_created: { name: "New Chat", is_name_implicit: true },
			}),
		).toEqual({ title: "New Chat", titleImplicit: true });
		// Explicit name at creation — never auto-title.
		expect(titleMetaFromService({ forum_topic_created: { name: "mine" } })).toEqual({
			title: "mine",
			titleImplicit: false,
		});
		// A named edit settles the debt; an icon-only edit leaves it alone.
		expect(titleMetaFromService({ forum_topic_edited: { name: "mine" } })).toEqual({
			title: "mine",
			titleImplicit: false,
		});
		expect(titleMetaFromService({ forum_topic_edited: {} })).toBeUndefined();
		expect(titleMetaFromService({})).toBeUndefined();
	});
});

describe("maybeRenameTopic", () => {
	test("implicitly-named topic gets renamed and the debt clears", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "topic", chatId: 42, threadId: 7 }, "/w");
		store.setMeta(conv.id, { title: "New Chat", titleImplicit: true });
		const fake = fakeApi();

		await maybeRenameTopic(
			{ api: fake.api, store, titleFor: () => Promise.resolve("Math questions") },
			conv,
			"2+5?",
		);

		expect(fake.calls).toEqual([
			{ method: "editForumTopic", args: [42, 7, { name: "Math questions" }] },
		]);
		const after = store.get(conv.id)!;
		expect(after.title).toBe("Math questions");
		expect(after.titleImplicit).toBe(false);
		store.close();
	});

	// The CAS: a rename the operator typed while the model was thinking
	// must never be overwritten.
	test("an operator rename mid-flight wins — no editForumTopic call", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "topic", chatId: 42, threadId: 7 }, "/w");
		store.setMeta(conv.id, { title: "New Chat", titleImplicit: true });
		const fake = fakeApi();
		const titleFor = () => {
			// Simulates forum_topic_edited landing during the model call.
			store.setMeta(conv.id, { title: "mine", titleImplicit: false });
			return Promise.resolve("Math questions");
		};

		await maybeRenameTopic({ api: fake.api, store, titleFor }, conv, "2+5?");

		expect(fake.calls).toEqual([]);
		expect(store.get(conv.id)!.title).toBe("mine");
		store.close();
	});

	test("an operator rename during Telegram's edit wins locally and is restored remotely", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "topic", chatId: 42, threadId: 7 }, "/w");
		store.setMeta(conv.id, { title: "New Chat", titleImplicit: true });
		const names: string[] = [];
		const api = fakeApi({
			handlers: {
				editForumTopic: async (_chat: number, _thread: number, opts: { name: string }) => {
					names.push(opts.name);
					if (names.length === 1) store.setMeta(conv.id, { title: "mine", titleImplicit: false });
					return true;
				},
			},
		}).api;
		await maybeRenameTopic({ api, store, titleFor: async () => "generated" }, conv, "question");
		expect(names).toEqual(["generated", "mine"]);
		expect(store.get(conv.id)?.title).toBe("mine");
		store.close();
	});

	test("null title leaves the placeholder and the flag", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "topic", chatId: 42, threadId: 7 }, "/w");
		store.setMeta(conv.id, { title: "New Chat", titleImplicit: true });
		const fake = fakeApi();

		await maybeRenameTopic(
			{ api: fake.api, store, titleFor: () => Promise.resolve(null) },
			conv,
			"2+5?",
		);

		expect(fake.calls).toEqual([]);
		expect(store.get(conv.id)!.titleImplicit).toBe(true);
		store.close();
	});
});
