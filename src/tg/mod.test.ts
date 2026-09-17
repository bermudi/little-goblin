import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { applyMenuButton } from "./mod.ts";

describe("applyMenuButton", () => {
	test("publicUrl maps to a web_app button; unset resets to default", async () => {
		const calls: unknown[] = [];
		const api = {
			setChatMenuButton: (opts: unknown) => {
				calls.push(opts);
				return Promise.resolve(true);
			},
		} as unknown as Api;

		applyMenuButton(api, "https://goblin.example.ts.net");
		applyMenuButton(api, undefined);
		await Promise.resolve();

		expect(calls).toEqual([
			{
				menu_button: {
					type: "web_app",
					text: "Settings",
					web_app: { url: "https://goblin.example.ts.net" },
				},
			},
			{ menu_button: { type: "default" } },
		]);
	});
});
