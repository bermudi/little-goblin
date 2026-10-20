// Approval callbacks are operator authority, checked on the live
// operators list — not the list that admitted the chat. A demoted
// account's stale buttons arrive through the sandbox gate legitimately
// and must decide nothing.

import { afterEach, describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import { parseConfig, type Config, type ConfigRef } from "../config.ts";
import { openStore } from "../conversation.ts";
import type { Runtime } from "../runtime.ts";
import { createBot, type BotDeps, type RunningBot } from "./mod.ts";

function testConfig(apiRoot: string): Config {
	return parseConfig({
		providers: {
			zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
		},
		model: "zai/m",
		operators: [1],
		allowedUsers: [2],
		// The sandbox lane exists, so friend DMs legitimately pass the
		// gate — the approval check is all that guards a privileged action.
		guest: {},
		telegram: { apiRoot },
	});
}

interface FakeTelegram {
	apiRoot: string;
	methods: string[];
	callbackAnswers: Array<Record<string, unknown>>;
	sentTexts: string[];
	stop: () => void;
}

function startFakeTelegram(): FakeTelegram {
	const methods: string[] = [];
	const callbackAnswers: Array<Record<string, unknown>> = [];
	const sentTexts: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const path = new URL(req.url).pathname;
			const method = path.slice(path.lastIndexOf("/") + 1);
			methods.push(method);
			if (method === "getMe")
				return Response.json({
					ok: true,
					result: { id: 99, is_bot: true, first_name: "goblin", username: "goblin_test_bot" },
				});
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
			if (method === "answerCallbackQuery") callbackAnswers.push(body);
			if (method === "sendMessage") sentTexts.push(String(body.text ?? ""));
			return Response.json({ ok: true, result: true });
		},
	});
	return {
		apiRoot: `http://127.0.0.1:${server.port}`,
		methods,
		callbackAnswers,
		sentTexts,
		stop: () => void server.stop(true),
	};
}

let tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-approval-gate-"));
	tempDirs.push(dir);
	return join(dir, "goblin.sqlite");
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

function callbackUpdate(userId: number, data: string): Update {
	return {
		update_id: 9,
		callback_query: {
			id: `cb-${userId}`,
			from: { id: userId, is_bot: false, first_name: "u" },
			// Approval keyboards live on bot messages in the user's DM.
			message: {
				message_id: 5,
				date: 0,
				chat: { id: userId, type: "private", first_name: "u" },
			},
			data,
		},
	} as Update;
}

async function withRealBot(body: (running: RunningBot) => Promise<void>): Promise<FakeTelegram> {
	const fake = startFakeTelegram();
	cleanups.push(fake.stop);
	const configRef: ConfigRef = { current: testConfig(fake.apiRoot), ttsDown: false };
	const running = await createBot(testDeps(configRef));
	await body(running);
	return fake;
}

// Flush the void-ed handler's promise chain — a tap's ack happens a
// few microtasks after handleUpdate resolves.
const settle = () => new Promise<void>((r) => setTimeout(r, 10));

afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("approval callbacks", () => {
	test("an allowed user's mail send tap is acked 'operator only' — the handler never runs", async () => {
		const fake = await withRealBot(async (running) => {
			await running.bot.handleUpdate(callbackUpdate(2, "mail:send:1"));
		});
		await settle();
		expect(fake.callbackAnswers).toEqual([{ callback_query_id: "cb-2", text: "operator only" }]);
		// Not "mail is not configured" — the operator check runs before
		// the mail lookup, so a demoted tap never reaches the mailbox.
		expect(fake.callbackAnswers[0]).not.toMatchObject({ text: "mail is not configured" });
	});

	test("an allowed user's skill install tap is acked 'operator only'", async () => {
		const fake = await withRealBot(async (running) => {
			await running.bot.handleUpdate(callbackUpdate(2, "skill:install:proposal:hash"));
		});
		await settle();
		expect(fake.callbackAnswers).toEqual([{ callback_query_id: "cb-2", text: "operator only" }]);
	});

	test("an operator's mail tap reaches the approval lookup, not the refusal", async () => {
		const fake = await withRealBot(async (running) => {
			await running.bot.handleUpdate(callbackUpdate(1, "mail:send:1"));
		});
		await settle();
		// No mail dep wired in this harness — reaching "not configured"
		// proves the operator check passed the tap through.
		expect(fake.callbackAnswers).toEqual([
			{ callback_query_id: "cb-1", text: "mail is not configured" },
		]);
	});

	test("an allowed user's program tap is acked 'operator only' — the store is never read", async () => {
		const fake = await withRealBot(async (running) => {
			await running.bot.handleUpdate(callbackUpdate(2, "program:approve:1"));
		});
		await settle();
		expect(fake.callbackAnswers).toEqual([{ callback_query_id: "cb-2", text: "operator only" }]);
	});

	test("an operator's program tap reaches the approval lookup, not the refusal", async () => {
		const fake = await withRealBot(async (running) => {
			await running.bot.handleUpdate(callbackUpdate(1, "program:approve:1"));
		});
		await settle();
		expect(fake.callbackAnswers).toEqual([
			{ callback_query_id: "cb-1", text: "program approvals are not configured" },
		]);
	});

	test("a demoted operator's program tap decides nothing — the gate reads live config", async () => {
		const fake = startFakeTelegram();
		cleanups.push(fake.stop);
		const configRef: ConfigRef = { current: testConfig(fake.apiRoot), ttsDown: false };
		let taps = 0;
		const running = await createBot({
			...testDeps(configRef),
			programApproval: () => ({
				requestApproval: async () => {},
				handleTap: async () => {
					taps++;
				},
			}),
		});
		await running.bot.handleUpdate(callbackUpdate(1, "program:approve:1"));
		await settle();
		expect(taps).toBe(1);
		configRef.current = { ...configRef.current, operators: [] };
		await running.bot.handleUpdate(callbackUpdate(1, "program:reject:1"));
		await settle();
		expect(taps).toBe(1);
		// The only wire answer is the demoted tap's refusal — the
		// fake's handleTap never answers its own query.
		expect(fake.callbackAnswers).toEqual([{ callback_query_id: "cb-1", text: "operator only" }]);
	});
});
