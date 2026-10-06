// The spin-off glue (design/app.md → Spin-off): the fork is a
// uuid-named app conversation titled by the delegation name, the link
// follows the configured host, and the fire-and-forget retitle lands
// through the shared titler — still implicit so an operator rename
// always wins.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { discardSpinOff, spinOff, type SpinOffDeps } from "./spinoff.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-spinoff-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}

describe("spinOff", () => {
	test("forks a uuid app copy, links off publicUrl, and retitles through titleFor", async () => {
		const store = openStore(tmpdb());
		const src = store.resolve({ kind: "dm", chatId: 5 }, "/w");
		store.setMeta(src.id, { model: "test/telegram", thinking: "max" });
		store.append(src.id, [
			{ id: "m", role: "user", parts: [{ type: "text", text: "deploy the thing" }] },
		]);
		const titles: string[] = [];
		const { conv, link } = spinOff(
			{
				store,
				titleFor: (text) => {
					titles.push(text);
					return Promise.resolve("Deploy the thing");
				},
				publicUrl: () => "https://g.example/",
				appDefaults: () => ({ model: "test/app", thinking: "low" }),
			},
			src,
			"the work",
		);
		expect(conv.id).toMatch(/^app\/[0-9a-f-]{36}$/);
		expect(conv.title).toBe("the work");
		expect(conv).toMatchObject({ model: "test/app", thinking: "low" });
		expect(conv.titleImplicit).toBe(true);
		expect(link).toBe(`https://g.example/app/c/${conv.id.slice("app/".length)}`);
		// The model view came along — the DM is a copy source.
		expect(store.history(conv.id)).toHaveLength(1);
		await Bun.sleep(20); // the fire-and-forget retitle
		expect(titles).toEqual(["deploy the thing"]);
		const retitled = store.get(conv.id)!;
		expect(retitled.title).toBe("Deploy the thing");
		// Still implicit — an operator rename always wins.
		expect(retitled.titleImplicit).toBe(true);
		store.close();
	});

	test("no publicUrl — the pin renders no link", () => {
		const store = openStore(tmpdb());
		const src = store.resolve({ kind: "dm", chatId: 5 }, "/w");
		const { link } = spinOff(
			{
				store,
				titleFor: () => Promise.resolve(null),
				publicUrl: () => undefined,
			},
			src,
			"x",
		);
		expect(link).toBeNull();
		store.close();
	});

	test("an explicit title already on the row is never overwritten", async () => {
		const store = openStore(tmpdb());
		const src = store.resolve({ kind: "dm", chatId: 5 }, "/w");
		store.append(src.id, [
			{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] },
		]);
		const { conv } = spinOff(
			{
				store,
				titleFor: () => Promise.resolve("model title"),
				publicUrl: () => undefined,
			},
			src,
			"the work",
		);
		// An operator rename that landed first wins over the async one.
		store.setMeta(conv.id, { title: "operator named", titleImplicit: false });
		await Bun.sleep(20);
		expect(store.get(conv.id)!.title).toBe("operator named");
		store.close();
	});
});

describe("discardSpinOff", () => {
	const deps = (store: ReturnType<typeof openStore>): SpinOffDeps => ({
		store,
		titleFor: () => Promise.resolve(null),
		publicUrl: () => undefined,
	});
	const user = (text: string) => ({
		id: `u-${text}`,
		role: "user" as const,
		parts: [{ type: "text" as const, text }],
	});

	test("an untouched fork is deleted", () => {
		const store = openStore(tmpdb());
		const src = store.resolve({ kind: "dm", chatId: 5 }, "/w");
		store.append(src.id, [user("deploy it")]);
		const { conv } = spinOff(deps(store), src, "the work");
		discardSpinOff(store, conv.id, store.lastSeq(conv.id), "cap reached");
		expect(store.get(conv.id)).toBeNull();
		expect(store.history(src.id)).toHaveLength(1);
		store.close();
	});

	test("a fork the operator wrote into is kept — input never rides the discard", () => {
		const store = openStore(tmpdb());
		const src = store.resolve({ kind: "dm", chatId: 5 }, "/w");
		store.append(src.id, [user("deploy it")]);
		const { conv } = spinOff(deps(store), src, "the work");
		const seqAtFork = store.lastSeq(conv.id);
		// The launch hadn't settled; the operator found the fork and
		// typed into it — deleting would eat their message.
		store.append(conv.id, [user("wait, also the cache")]);
		discardSpinOff(store, conv.id, seqAtFork, "failed");
		expect(store.get(conv.id)).not.toBeNull();
		expect(store.history(conv.id)).toHaveLength(2);
		store.close();
	});
});
