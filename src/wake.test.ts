import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { openStore } from "./conversation.ts";
import type { Config } from "./config.ts";
import { Runtime } from "./runtime.ts";
import { wake } from "./wake.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

test("wake after runtime close records history but does not report delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-wake-"));
	dirs.push(dir);
	const store = openStore(join(dir, "goblin.sqlite"));
	const runtime = new Runtime({
		store,
		buildStep: () => { throw new Error("closed runtime must not run a turn"); },
		makeTools: () => ({}),
	});
	await runtime.shutdown();
	const config: Config = {
		providers: {}, model: "unused/m", tts: false, favorites: [],
		thinking: "medium", allowedUsers: [1], telegram: {},
		http: { port: 8787 }, logLevel: "info",
	};
	const api = {
		sendMessage: () => { throw new Error("history-only notice must not reach Telegram"); },
		sendChatAction: () => Promise.resolve(true), // sink sends an initial typing ping on construction
	} as unknown as Api;
	const landed = wake({
		store, runtime, api, configRef: { current: config, ttsDown: false },
		synthesize: async () => [],
	}, { chatId: 1, threadId: 42 }, "delegation notice");
	await Promise.resolve(); // closed runtime fences the sink asynchronously
	expect(landed).toBe(false);
	expect(store.history("topic:1:42").map((message) => message.parts)).toEqual([
		[{ type: "text", text: "delegation notice" }],
	]);
	store.close();
});
