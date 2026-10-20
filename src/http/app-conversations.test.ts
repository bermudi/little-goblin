import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { _primeModelsDevForTest, _resetModelsDevForTest } from "../agent/models-dev.ts";
import { appAddress, openStore, type ConversationStore } from "../conversation.ts";
import type { Runtime } from "../runtime.ts";
import { HeadlessSink, sleep, waitUntil } from "../testkit.ts";
import { openTurnJournal } from "../turn-journal.ts";
import { makeResumeOps } from "../turn-resume.ts";
import { handleAppApi } from "./app-channel.ts";
import { APP_TOKEN_NAME, createAndChat, setup } from "./app-testing.ts";
import type { AppInterruptedList, AppResumeBlocked } from "./app-wire.ts";

describe("app conversations", () => {
	test("create, list, and history ride the app pool only", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			store.resolve({ kind: "dm", chatId: 99 }, "/w");
			const created = await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01", title: "First" }),
			});
			expect(created.status).toBe(201);
			const createdBody = (await created.json()) as { id: string; title: string | null };
			expect(createdBody.id).toBe("app/chat-01");
			expect(createdBody.title).toBe("First");

			const list = await call("/api/app/conversations");
			const listBody = (await list.json()) as { conversations: { id: string }[] };
			expect(listBody.conversations.map((c) => c.id)).toEqual(["app/chat-01"]);

			expect((await call("/api/app/conversations/dm-1/messages")).status).toBe(404);
			expect((await call("/api/app/conversations/../x/messages")).status).toBe(404);

			const messages = await call("/api/app/conversations/chat-01/messages");
			expect(messages.status).toBe(200);
			expect((await messages.json()) as { messages: unknown[] }).toEqual({ messages: [] });
		} finally {
			http.stop();
		}
	});

	test("stop aborts a live turn — the stream ends with the error chunk", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(chat.status).toBe(200);
			const stop = await call("/api/app/conversations/chat-01/stop", { method: "POST" });
			expect(stop.status).toBe(200);
			expect((await stop.json()) as { stopped: boolean }).toEqual({ stopped: true });
			const body = await chat.text();
			expect(body).toContain('"type":"error"');
			expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("stop on an idle or unknown conversation stays honest", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const idle = await call("/api/app/conversations/chat-01/stop", { method: "POST" });
			expect(idle.status).toBe(200);
			expect((await idle.json()) as { stopped: boolean }).toEqual({ stopped: false });
			expect((await call("/api/app/conversations/ghost/stop", { method: "POST" })).status).toBe(
				404,
			);
		} finally {
			http.stop();
		}
	});

	test("compact folds history through the lane — the manual lever", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			compaction: {
				modelRef: () => "m",
				contextWindow: () => null,
				summarize: async () => "folded",
			},
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const big = "past ".repeat(25000);
			for (let i = 0; i < 4; i++) {
				store.append("app/chat-01", [
					{ id: `u${i}`, role: "user", parts: [{ type: "text", text: `${big} ${i}` }] },
				]);
				store.append("app/chat-01", [
					{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: "done" }] },
				]);
			}
			const res = await call("/api/app/conversations/chat-01/compact", { method: "POST" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as
				| { compacted: true; eventsCompacted: number; tailEvents: number; tokensBefore: number }
				| { compacted: false; reason: string };
			expect(body).toMatchObject({ compacted: true });
			if (body.compacted) {
				expect(body.eventsCompacted).toBeGreaterThan(0);
				expect(body.tokensBefore).toBeGreaterThan(0);
			}
			expect(store.getCompaction("app/chat-01")).not.toBeNull();

			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-02" }),
			});
			const noop = await call("/api/app/conversations/chat-02/compact", { method: "POST" });
			expect(await noop.json()).toEqual({
				compacted: false,
				reason: "nothing worth compacting",
			});
			expect((await call("/api/app/conversations/ghost/compact", { method: "POST" })).status).toBe(
				404,
			);
			expect((await call("/api/app/conversations/chat-02/compact")).status).toBe(405);
		} finally {
			http.stop();
		}
	});

	test("GET stream: 204 when idle; replay + tail + [DONE] mid-turn", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 60,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const idle = await call("/api/app/conversations/chat-01/stream");
			expect(idle.status).toBe(204);
			const wrongMethod = await call("/api/app/conversations/chat-01/stream", { method: "POST" });
			expect(wrongMethod.status).toBe(405);
			const missing = await call("/api/app/conversations/nope/stream");
			expect(missing.status).toBe(404);
			const chatP = call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			await Bun.sleep(140);
			const res = await call("/api/app/conversations/chat-01/stream");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			const text = await res.text();
			const events = text
				.split("\n\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice("data: ".length));
			expect(events.at(-1)).toBe("[DONE]");
			expect(JSON.parse(events[0]!) as { type: string }).toMatchObject({ type: "start" });
			const types = events
				.filter((e) => e !== "[DONE]")
				.map((e) => (JSON.parse(e) as { type: string }).type);
			expect(types).toContain("text-delta");
			expect(types.filter((t) => t === "start")).toHaveLength(1);
			await chatP;
		} finally {
			http.stop();
		}
	});

	test("the idle 204 never precedes durability — history holds the reply the moment the stream endpoint says nothing is live (#79)", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 25,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chatP = call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			let seenLive = false;
			let wentIdle = false;
			for (let i = 0; i < 500 && !wentIdle; i++) {
				const probe = await call("/api/app/conversations/chat-01/stream");
				if (probe.status === 200) {
					seenLive = true;
					await probe.body?.cancel();
				} else if (probe.status === 204 && seenLive) {
					wentIdle = true;
				}
				if (!wentIdle) await Bun.sleep(5);
			}
			expect(seenLive).toBe(true);
			expect(wentIdle).toBe(true);
			const history = store.history("app/chat-01");
			expect(
				history.some(
					(m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text !== ""),
				),
			).toBe(true);
			await chatP;
		} finally {
			http.stop();
		}
	});

	test("rename writes an explicit title; empty or unknown ids refuse", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call);
			const res = await call("/api/app/conversations/chat-01", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "Renamed thread" }),
			});
			expect(res.status).toBe(200);
			expect((await res.json()) as { title: string }).toEqual({ title: "Renamed thread" });
			const conv = store.get("app/chat-01");
			expect(conv?.title).toBe("Renamed thread");
			expect(conv?.titleImplicit).toBe(false);

			const empty = await call("/api/app/conversations/chat-01", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "" }),
			});
			expect(empty.status).toBe(422);
			expect(
				(
					await call("/api/app/conversations/ghost", {
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ title: "x" }),
					})
				).status,
			).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("archive toggles the flag, keeps history, and a new turn resurrects the row", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		const patch = (body: unknown) =>
			call("/api/app/conversations/chat-01", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		try {
			await createAndChat(call, "archivable-marker text");
			const res = await patch({ archived: true });
			expect(res.status).toBe(200);
			expect((await res.json()) as { archived: boolean }).toEqual({ archived: true });
			expect(store.get("app/chat-01")?.archivedAt).not.toBeNull();
			const listed = store.listAppConversations().find((c) => c.id === "app/chat-01");
			expect(listed?.archivedAt).not.toBeNull();

			expect(store.history("app/chat-01").length).toBeGreaterThan(0);
			const hits = (await (await call("/api/app/search?q=archivable")).json()) as {
				hits: { conversationId: string }[];
			};
			expect(hits.hits.map((h) => h.conversationId)).toContain("app/chat-01");

			expect((await patch({})).status).toBe(422);
			expect(
				(
					await call("/api/app/conversations/ghost", {
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ archived: true }),
					})
				).status,
			).toBe(404);

			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m2", role: "user", parts: [{ type: "text", text: "back again" }] },
				}),
			});
			expect(chat.status).toBe(200);
			await chat.text();
			expect(store.get("app/chat-01")?.archivedAt).toBeNull();
		} finally {
			http.stop();
		}
	});

	test("pin PATCH floats the row; archiving clears the pin server-side", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		const patch = (body: unknown) =>
			call("/api/app/conversations/chat-01", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		try {
			await createAndChat(call, "pinnable-marker text");
			const res = await patch({ pinned: true });
			expect(res.status).toBe(200);
			expect((await res.json()) as { pinned: boolean }).toEqual({ pinned: true });
			expect(store.get("app/chat-01")?.pinnedAt).not.toBeNull();
			expect(store.listAppConversations()[0]?.id).toBe("app/chat-01");

			await patch({ archived: true });
			expect(store.get("app/chat-01")?.pinnedAt).toBeNull();

			const conflict = await patch({ pinned: true });
			expect(conflict.status).toBe(409);
			const combo = await patch({ archived: true, pinned: true });
			expect(combo.status).toBe(409);
			expect(store.get("app/chat-01")?.archivedAt).not.toBeNull();
			expect(store.get("app/chat-01")?.pinnedAt).toBeNull();

			await patch({ archived: false });
			expect(store.get("app/chat-01")?.pinnedAt).toBeNull();
			const unarchivePin = await patch({ archived: false, pinned: true });
			expect(unarchivePin.status).toBe(200);
			expect(store.get("app/chat-01")?.archivedAt).toBeNull();
			expect(store.get("app/chat-01")?.pinnedAt).not.toBeNull();
		} finally {
			http.stop();
		}
	});

	test("delete removes the row, its events, and the FTS index", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call, "deletable-marker text");
			expect((await call("/api/app/search?q=deletable")).status).toBe(200);
			const hitsBefore = (await (await call("/api/app/search?q=deletable")).json()) as {
				hits: { conversationId: string }[];
			};
			expect(hitsBefore.hits.length).toBeGreaterThan(0);

			const res = await call("/api/app/conversations/chat-01", { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(store.get("app/chat-01")).toBeNull();
			expect(store.history("app/chat-01")).toEqual([]);
			expect(store.listAppConversations()).toEqual([]);
			const hitsAfter = (await (await call("/api/app/search?q=deletable")).json()) as {
				hits: { conversationId: string }[];
			};
			expect(hitsAfter.hits).toEqual([]);
			expect((await call("/api/app/conversations/ghost", { method: "DELETE" })).status).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("delete fences a live turn before the row goes", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(chat.status).toBe(200);
			const del = await call("/api/app/conversations/chat-01", { method: "DELETE" });
			expect(del.status).toBe(200);
			expect(store.get("app/chat-01")).toBeNull();
			const body = await chat.text();
			expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("search scopes to the app pool — telegram hits never leak", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			const tg = store.resolve({ kind: "dm", chatId: 99 }, "/w");
			store.append(tg.id, [
				{ id: "tg1", role: "user", parts: [{ type: "text", text: "needle in telegram" }] },
			]);
			await createAndChat(call, "needle in the app pool");

			const res = await call("/api/app/search?q=needle");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hits: { conversationId: string; role: string; text: string }[];
			};
			expect(body.hits.length).toBeGreaterThan(0);
			expect(body.hits.every((h) => h.conversationId.startsWith("app/"))).toBe(true);
			expect(body.hits.some((h) => h.text.includes("needle in the app pool"))).toBe(true);

			const tgOnly = (await (await call("/api/app/search?q=telegram")).json()) as {
				hits: unknown[];
			};
			expect(tgOnly.hits).toEqual([]);
			expect((await call("/api/app/search?q=")).status).toBe(200);
			expect((await call(`/api/app/search?q=${"x".repeat(257)}`)).status).toBe(400);
		} finally {
			http.stop();
		}
	});
});

test("conversation settings are isolated, durable, validated, and only future chats use changed app defaults", async () => {
	const { http, call, store, configRef, configWrites, home } = setup();
	const patch = (path: string, body: unknown) =>
		call(path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		const legacy = store.resolve(appAddress("legacy-settings"), "/work");
		const create = (id: string) =>
			call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
		await create("settings-a");
		await create("settings-b");
		const a = "/api/app/conversations/settings-a/config";
		const epoch = store.get("app/settings-a")!.epoch;
		expect((await patch(a, { model: "zai/personal", thinking: "high" })).status).toBe(200);
		expect(store.get("app/settings-a")!.epoch).toBe(epoch);
		expect(configWrites.count).toBe(0);
		expect(store.get("app/settings-b")).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect((await patch(a, { model: "missing/x" })).status).toBe(422);
		expect((await patch(a, { model: "bare" })).status).toBe(422);
		const sentinel = "CONFIG_FAKE_SECRET_SENTINEL";
		for (const path of [a, "/api/app/config"]) {
			const refused = await patch(path, { model: sentinel });
			expect(refused.status).toBe(422);
			expect(await refused.text()).not.toContain(sentinel);
		}
		expect((await patch(a, { thinking: "invalid" })).status).toBe(422);
		expect((await patch(a, {})).status).toBe(422);
		expect(
			(await patch("/api/app/conversations/not-created/config", { model: "zai/x" })).status,
		).toBe(404);
		expect(store.get("app/not-created")).toBeNull();
		store.resolve({ kind: "dm", chatId: 42 }, "/work");
		expect((await patch("/api/app/conversations/dm%3A42/config", { model: "zai/x" })).status).toBe(
			404,
		);
		expect(
			(await patch("/api/app/conversations/app%2Fsettings-a/config", { model: "zai/x" })).status,
		).toBe(404);
		expect((await patch("/api/app/config", { model: "zai/future", thinking: "low" })).status).toBe(
			200,
		);
		expect(configRef.current.telegram).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect(store.get(legacy.id)).toMatchObject({ model: "zai/m", thinking: "medium" });
		await create("settings-future");
		await create("settings-a");
		expect(store.get("app/settings-future")).toMatchObject({
			model: "zai/future",
			thinking: "low",
		});
		const view = await (await call(a)).json();
		expect(view).toMatchObject({
			model: "zai/personal",
			thinking: "high",
			favorites: [],
			thinkingLevels: expect.any(Array),
		});
		store.close();
		const reopened = openStore(join(home, "goblin.sqlite"));
		try {
			expect(reopened.get("app/settings-a")).toMatchObject({
				model: "zai/personal",
				thinking: "high",
			});
		} finally {
			reopened.close();
		}
	} finally {
		http.stop();
	}
});

test("conversation context reports last-turn usage, limit, and cache rates", async () => {
	const { http, call } = setup();
	_primeModelsDevForTest({ zai: { models: { m: { limit: { context: 1000 } } } } });
	try {
		expect((await call("/api/app/conversations/nope/context")).status).toBe(404);
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "ctx-01" }),
		});
		const empty = (await (await call("/api/app/conversations/ctx-01/context")).json()) as Record<
			string,
			unknown
		>;
		expect(empty).toMatchObject({
			model: "zai/m",
			input: null,
			output: null,
			limit: 1000,
			pct: null,
			turns: 0,
			cacheHitRate: null,
			avgCacheHitRate: null,
		});
		await createAndChat(call, "hi", "ctx-01");
		const one = (await (await call("/api/app/conversations/ctx-01/context")).json()) as Record<
			string,
			unknown
		>;
		expect(one).toMatchObject({
			model: "zai/m",
			input: 1,
			output: 2,
			limit: 1000,
			pct: 0.1,
			turns: 1,
			cacheHitRate: null,
			avgCacheHitRate: null,
		});
		// The turn ran the real stream path, so the itemization rode along.
		expect((one as { segments: unknown }).segments).not.toBeNull();
		expect(
			(
				await call("/api/app/conversations/ctx-01/context", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(405);
	} finally {
		_resetModelsDevForTest();
		http.stop();
	}
});

test("context prefers the final step's input and itemizes the window", async () => {
	const { http, call, store } = setup();
	_primeModelsDevForTest({ zai: { models: { m: { limit: { context: 1000 } } } } });
	try {
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "ctx-02" }),
		});
		// A turn's metadata as stream.ts now writes it: `input` is the
		// whole tool loop's billed sum, `lastInput` the final step — the
		// gauge must read the latter and scale the segments to it.
		store.append("app/ctx-02", [
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "text", text: "done" }],
				metadata: {
					model: "zai/m",
					finishReason: "stop",
					durationMs: 5,
					forcedCompletion: null,
					usage: {
						input: 900,
						output: 10,
						cacheRead: 800,
						cacheWrite: null,
						lastInput: 300,
						lastCacheRead: 280,
					},
					promptChars: {
						identity: 100,
						environment: 50,
						skills: 50,
						toolDefs: 50,
						history: 250,
						toolResults: 100,
					},
				},
			},
		]);
		const body = (await (await call("/api/app/conversations/ctx-02/context")).json()) as {
			input: number | null;
			cacheRead: number | null;
			cacheHitRate: number | null;
			pct: number | null;
			segments: { key: string; tokens: number }[] | null;
		};
		// 300, not the 900 billed sum.
		expect(body.input).toBe(300);
		expect(body.cacheRead).toBe(280);
		expect(body.cacheHitRate).toBeCloseTo(280 / 300, 5);
		expect(body.pct).toBe(30);
		// 500 chars scale to 300 tokens; toolResults is a subset, scaled
		// against the same denominator so it never double-counts.
		expect(body.segments).toEqual([
			{ key: "identity", tokens: 60 },
			{ key: "environment", tokens: 30 },
			{ key: "skills", tokens: 30 },
			{ key: "toolDefs", tokens: 30 },
			{ key: "history", tokens: 150 },
			{ key: "toolResults", tokens: 60 },
		]);
	} finally {
		_resetModelsDevForTest();
		http.stop();
	}
});

test.each([
	{ name: "legacy", final: {}, input: 900, cacheRead: 800 },
	{
		name: "explicit null",
		final: { lastInput: null, lastCacheRead: null },
		input: null,
		cacheRead: null,
	},
	{
		name: "missing final cache",
		final: { lastInput: 300 },
		input: 300,
		cacheRead: null,
	},
	{
		name: "null final cache",
		final: { lastInput: 300, lastCacheRead: null },
		input: 300,
		cacheRead: null,
	},
	{
		name: "missing final input",
		final: { lastCacheRead: 280 },
		input: null,
		cacheRead: 280,
	},
	{
		name: "null final input",
		final: { lastInput: null, lastCacheRead: 280 },
		input: null,
		cacheRead: 280,
	},
])("context preserves final-step availability: $name", async ({ final, input, cacheRead }) => {
	const { http, call, store } = setup();
	_primeModelsDevForTest({ zai: { models: { m: { limit: { context: 1000 } } } } });
	try {
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "ctx-availability" }),
		});
		store.append("app/ctx-availability", [
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "text", text: "done" }],
				metadata: {
					usage: { input: 900, output: 10, cacheRead: 800, ...final },
					promptChars: { identity: 100 },
				},
			},
		]);
		const body = await (await call("/api/app/conversations/ctx-availability/context")).json();
		expect(body).toMatchObject({
			input,
			cacheRead,
			turns: 1,
			pct: input === null ? null : input / 10,
			cacheHitRate: input === null || cacheRead === null ? null : cacheRead / input,
			avgCacheHitRate: input === null || cacheRead === null ? null : cacheRead / input,
			segments: input === null ? null : [{ key: "identity", tokens: input }],
		});
	} finally {
		_resetModelsDevForTest();
		http.stop();
	}
});

test("conversation PATCH rechecks the live registry and row after awaiting its request body", async () => {
	const { http, store, configRef, appDeps } = setup();
	const row = store.resolve(appAddress("held-config"), "/work", configRef.current);
	async function heldPatch(body: unknown, mutate: () => void): Promise<Response> {
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const waiting = new Promise<void>((r) => {
			release = r;
		});
		const reading = new Promise<void>((r) => {
			entered = r;
		});
		class HeldRequest extends Request {
			override json = async (): Promise<unknown> => {
				entered();
				await waiting;
				return body;
			};
		}
		const url = new URL("http://localhost/api/app/conversations/held-config/config");
		const pending = handleAppApi(
			new HeldRequest(url.href, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
			}),
			url,
			undefined,
			appDeps,
		);
		await reading;
		mutate();
		release();
		return pending;
	}
	try {
		configRef.current.providers.other = { kind: "codex" };
		expect(
			(
				await heldPatch({ model: "other/chat" }, () => {
					delete configRef.current.providers.other;
				})
			).status,
		).toBe(422);
		expect(store.get(row.id)!.model).toBe("zai/m");
		expect(
			(await heldPatch({ thinking: "high" }, () => store.deleteConversation(row.id))).status,
		).toBe(404);
		expect(store.get(row.id)).toBeNull();
	} finally {
		http.stop();
		store.close();
	}
});

describe("app channel interrupted-run routes", () => {
	function setupWithResume(opts: Parameters<typeof setup>[0] = {}) {
		const fixture = setup(opts);
		const wired = wireResume(fixture.store, fixture.runtime, fixture.turnJournal);
		fixture.appDeps.resumeOps = () => wired.ops;
		return { ...fixture, wired };
	}

	function wireResume(
		store: ConversationStore,
		runtime: Runtime,
		journal: ReturnType<typeof openTurnJournal>,
	) {
		const notices: { convId: string; runId: string; done: string }[] = [];
		const ops = makeResumeOps({
			store,
			journal,
			runtime,
			captureConversation: (c) => c,
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({ q: z.number() }),
					execute: async () => ({ ok: true }),
				}),
			}),
			sinkFor: () => new HeadlessSink(),
			sinkHooks: () => ({ voice: false, recording: false, file: false }),
			notifyDone: (c, runId, done) => notices.push({ convId: c.id, runId, done: done.kind }),
		});
		return { journal, ops, notices };
	}

	function interruptedRun(
		store: ConversationStore,
		journal: ReturnType<typeof openTurnJournal>,
		convId: string,
		runId: string,
		opts: { anchorSeq?: number | null } = {},
	) {
		const conv = store.get(convId)!;
		journal.beginRun({
			runId,
			conversationId: convId,
			epoch: conv.epoch,
			anchorSeq: opts.anchorSeq ?? null,
			steerMark: null,
			convSnapshot: { model: conv.model, thinking: conv.thinking },
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:00:00.000Z",
		});
		store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = ?", [runId]);
	}

	async function makeConv(call: ReturnType<typeof setup>["call"], id = "chat-01") {
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		return `app/${id}`;
	}

	test("GET interrupted lists the run and its calls; 404s unknown convs", async () => {
		const { http, call, store, wired } = setupWithResume();
		try {
			const convId = await makeConv(call);
			interruptedRun(store, wired.journal, convId, "run-dead");
			wired.journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
			wired.journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });
			wired.journal.noteToolInput("run-dead", "c2", "probe", { q: 2 });
			wired.journal.noteToolDispatch("run-dead", "c2", "probe", { q: 2 });
			wired.journal.resolveCall("run-dead", "c2", "skip");

			const res = await call("/api/app/conversations/chat-01/interrupted");
			expect(res.status).toBe(200);
			const body = (await res.json()) as AppInterruptedList;
			expect(body.runs).toHaveLength(1);
			expect(body.runs[0]!.runId).toBe("run-dead");
			expect(body.runs[0]!.calls.dispatched).toBe(1);
			expect(body.runs[0]!.calls.resolved).toBe(1);
			expect(body.runs[0]!.toolCalls[0]!.state).toBe("dispatched");
			expect(body.runs[0]!.toolCalls[0]!.canAuthorizeRetry).toBe(true);
			expect(body.runs[0]!.toolCalls[1]!.state).toBe("resolved-skip");
			expect(body.runs[0]!.toolCalls[1]!.canAuthorizeRetry).toBe(false);

			expect((await call("/api/app/conversations/ghost/interrupted")).status).toBe(404);
			expect(
				(await call("/api/app/conversations/chat-01/interrupted", { method: "DELETE" })).status,
			).toBe(405);
		} finally {
			http.stop();
		}
	});

	test("the routes refuse 503 when resume ops are not wired", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			await makeConv(call);
			expect((await call("/api/app/conversations/chat-01/interrupted")).status).toBe(503);
			expect(
				(
					await call("/api/app/conversations/chat-01/runs/x/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId: "c1", decision: "skip" }),
					})
				).status,
			).toBe(503);
			expect(
				(await call("/api/app/conversations/chat-01/runs/x/resume", { method: "POST" })).status,
			).toBe(503);
		} finally {
			http.stop();
		}
	});

	test("decide validates the body, lands the verdict, and conflicts on a settled call", async () => {
		const { http, call, store, wired } = setupWithResume();
		try {
			const convId = await makeConv(call);
			interruptedRun(store, wired.journal, convId, "run-dead");
			wired.journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
			wired.journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });

			expect(
				(
					await call("/api/app/conversations/chat-01/runs/run-dead/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{not json",
					})
				).status,
			).toBe(400);
			expect(
				(
					await call("/api/app/conversations/chat-01/runs/run-dead/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId: "c1", decision: "maybe" }),
					})
				).status,
			).toBe(422);
			expect(
				(
					await call("/api/app/conversations/chat-01/runs/run-dead/decide", {
						method: "POST",
						body: "callId=c1",
					})
				).status,
			).toBe(415);

			const ok = await call("/api/app/conversations/chat-01/runs/run-dead/decide", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ callId: "c1", decision: "record-result", note: "landed" }),
			});
			expect(ok.status).toBe(200);
			expect(await ok.json()).toEqual({ ok: true });
			expect(wired.journal.callsFor("run-dead")[0]!.state).toBe("resolved-done");

			expect(
				(
					await call("/api/app/conversations/chat-01/runs/run-dead/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId: "c1", decision: "skip" }),
					})
				).status,
			).toBe(409);
			expect(
				(
					await call("/api/app/conversations/chat-01/runs/nope/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId: "c1", decision: "skip" }),
					})
				).status,
			).toBe(404);
			expect(
				(
					await call("/api/app/conversations/ghost/runs/run-dead/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId: "c1", decision: "skip" }),
					})
				).status,
			).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("huge recorded args ride the wire as bounded previews — list and resume-409", async () => {
		const { http, call, store, wired } = setupWithResume();
		try {
			const convId = await makeConv(call);
			interruptedRun(store, wired.journal, convId, "run-dead");
			const huge = { content: "x".repeat(1_000_000) };
			wired.journal.noteToolInput("run-dead", "c1", "probe", huge);
			wired.journal.noteToolDispatch("run-dead", "c1", "probe", huge);
			wired.journal.noteToolInput("run-dead", "c2", "probe", { q: 2 });
			wired.journal.noteToolDispatch("run-dead", "c2", "probe", { q: 2 });
			store.db.run("UPDATE turn_tool_calls SET args = ? WHERE run_id = ? AND tool_call_id = ?", [
				JSON.stringify(huge),
				"run-dead",
				"c2",
			]);

			const res = await call("/api/app/conversations/chat-01/interrupted");
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text.length).toBeLessThan(100_000);
			expect(text).toContain("[truncated]");

			const blocked = await call("/api/app/conversations/chat-01/runs/run-dead/resume", {
				method: "POST",
			});
			expect(blocked.status).toBe(409);
			const btext = await blocked.text();
			expect(btext.length).toBeLessThan(100_000);
			expect(btext).toContain("[truncated]");
			const body = JSON.parse(btext) as AppResumeBlocked;
			expect(body.calls).toHaveLength(2);
		} finally {
			http.stop();
		}
	});

	test("a corrupt run row still lists and refuses resume 422; healthy rows unaffected", async () => {
		const { http, call, store, wired } = setupWithResume();
		try {
			const convId = await makeConv(call);
			interruptedRun(store, wired.journal, convId, "run-bad");
			interruptedRun(store, wired.journal, convId, "run-good");
			store.db.run("UPDATE turn_runs SET tool_names = ? WHERE run_id = ?", ["{nope", "run-bad"]);

			const res = await call("/api/app/conversations/chat-01/interrupted");
			expect(res.status).toBe(200);
			const body = (await res.json()) as AppInterruptedList;
			expect(body.runs.map((r) => r.runId).sort()).toEqual(["run-bad", "run-good"]);

			const resumed = await call("/api/app/conversations/chat-01/runs/run-bad/resume", {
				method: "POST",
			});
			expect(resumed.status).toBe(422);
			const refused = (await resumed.json()) as { error: string };
			expect(refused.error).toContain("tool surface is unreadable");
			expect(wired.journal.get("run-bad")!.status).toBe("interrupted");
		} finally {
			http.stop();
		}
	});

	test("resume answers 409 with the undecided calls, then admits on the second ask", async () => {
		const { http, call, store, runtime, wired } = setupWithResume();
		try {
			const convId = await makeConv(call);
			const seq = store.modelEntries(convId);
			interruptedRun(store, wired.journal, convId, "run-dead", {
				anchorSeq: seq.at(-1)?.seq ?? null,
			});
			wired.journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
			wired.journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });

			const blocked = await call("/api/app/conversations/chat-01/runs/run-dead/resume", {
				method: "POST",
			});
			expect(blocked.status).toBe(409);
			const blockedBody = (await blocked.json()) as AppResumeBlocked;
			expect(blockedBody.calls).toHaveLength(1);
			expect(blockedBody.calls[0]!.toolCallId).toBe("c1");

			expect(
				(
					await call("/api/app/conversations/chat-01/runs/run-dead/decide", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId: "c1", decision: "skip" }),
					})
				).status,
			).toBe(200);

			const resumed = await call("/api/app/conversations/chat-01/runs/run-dead/resume", {
				method: "POST",
			});
			expect(resumed.status).toBe(200);
			expect(await resumed.json()).toEqual({ resumed: true, runId: "run-dead" });
			await waitUntil(() => wired.notices.length === 1, "done notice");
			expect(wired.notices[0]!.runId).toBe("run-dead");
			expect(wired.notices[0]!.done).toBe("completed");
			expect(wired.journal.get("run-dead")!.status).toBe("resumed");

			expect(
				(
					await call("/api/app/conversations/chat-01/runs/run-dead/resume", {
						method: "POST",
					})
				).status,
			).toBe(404);
			expect(
				(
					await call("/api/app/conversations/chat-01/runs/ghost-run/resume", {
						method: "POST",
					})
				).status,
			).toBe(404);
			void runtime;
		} finally {
			http.stop();
		}
	});
});
