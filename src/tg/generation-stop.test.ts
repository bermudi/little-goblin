// stopped_message_generation reaches the log — but only because the real
// createBot registers its handler *above* the access gate. The update has no
// sender, so the gate would drop it at debug level first. These tests drive
// that shipped wiring (createBot over a fake Bot API), not a test-local
// middleware stack: moving the registration below the gate must go red here.
//
// The update shape is per @grammyjs/types 5.0.0 (MessageGenerationStopped),
// not yet observed on a live wire — label any claim about the wire unverified.

import { tmpdb } from "../testkit.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";

import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import { parseConfig, type Config, type ConfigRef } from "../config.ts";
import { openStore } from "../conversation.ts";
import { setLogFile, setLogWriter } from "../log.ts";
import type { Runtime } from "../runtime.ts";
import { createBot, type BotDeps, type RunningBot } from "./mod.ts";

// parseConfig rather than a hand-copied literal — the schema owns the shape.
function testConfig(apiRoot?: string): Config {
	return parseConfig({
		providers: {
			zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
		},
		model: "zai/m",
		operators: [1],
		allowedUsers: [2],
		...(apiRoot !== undefined ? { telegram: { apiRoot } } : {}),
	});
}

// Telegram's transport is the boundary we fake: a server that answers getMe
// and swallows everything else. This is what makes the *real* createBot
// runnable in-process, so the ordering under test is the shipped ordering.
function startFakeTelegram(): { apiRoot: string; stop: () => void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			new URL(req.url).pathname.endsWith("/getMe")
				? Response.json({
						ok: true,
						result: {
							id: 99,
							is_bot: true,
							first_name: "goblin",
							username: "goblin_test_bot",
						},
					})
				: Response.json({ ok: true, result: true }),
	});
	return { apiRoot: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

function testDeps(configRef: ConfigRef): BotDeps {
	return {
		configRef,
		auth: { resolve: () => Promise.resolve("test-token") } as unknown as AuthStore,
		store: openStore(tmpdb()),
		runtime: {
			hasActiveTurn: () => false,
			submitPersisted: () => {},
			busy: () => false,
			stop: () => ({ stopped: true, settled: Promise.resolve(), reviewsCancelled: 0 }),
			cancelFenced: () => ({ stopped: true, settled: Promise.resolve(), reviewsCancelled: 0 }),
		} as unknown as Runtime,
		titleFor: () => Promise.resolve(null),
		transcribe: () => Promise.resolve(null),
		synthesize: () => Promise.resolve([]),
	};
}

function stopUpdate(fields: { threadId?: number }): Update {
	return {
		update_id: 7,
		stopped_message_generation: {
			chat: { id: 42, type: "private", first_name: "op" },
			draft_id: 555,
			...(fields.threadId !== undefined ? { message_thread_id: fields.threadId } : {}),
		},
	} as Update;
}

const lines: string[] = [];
const cleanups: Array<() => void> = [];

function captureLog(): void {
	setLogFile("/tmp/generation-stop-test.log");
	setLogWriter((_path, line) => lines.push(line));
}

function stopRecords(): Record<string, unknown>[] {
	return lines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((rec) => rec.msg === "message generation stop received");
}

// Boot the real createBot against a fake Bot API, run the body, tear down.
async function withRealBot(body: (bot: RunningBot["bot"]) => Promise<void>): Promise<void> {
	const fake = startFakeTelegram();
	cleanups.push(fake.stop);
	const configRef: ConfigRef = { current: testConfig(fake.apiRoot), ttsDown: false };
	const running = await createBot(testDeps(configRef));
	await body(running.bot);
}

afterEach(() => {
	lines.length = 0;
	setLogWriter(null);
	setLogFile(null);
	for (const fn of cleanups.splice(0)) fn();
});

describe("stopped_message_generation", () => {
	test("the shipped stack logs it with update, chat, draft, and thread", async () => {
		captureLog();
		await withRealBot(async (bot) => {
			await bot.handleUpdate(stopUpdate({ threadId: 3 }));
		});
		expect(stopRecords()).toEqual([
			expect.objectContaining({ level: "info", update: 7, chat: 42, draft: 555, thread: 3 }),
		]);
	});

	test("a stop outside a topic logs thread as null, not undefined", async () => {
		captureLog();
		await withRealBot(async (bot) => {
			await bot.handleUpdate(stopUpdate({}));
		});
		expect(stopRecords()).toEqual([expect.objectContaining({ thread: null })]);
	});
});
