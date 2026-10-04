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
import { spinOff } from "./spinoff.ts";

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
			},
			src,
			"the work",
		);
		expect(conv.id).toMatch(/^app\/[0-9a-f-]{36}$/);
		expect(conv.title).toBe("the work");
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
