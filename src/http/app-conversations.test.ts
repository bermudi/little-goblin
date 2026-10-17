import { describe, expect, test } from "bun:test";
import { _primeModelsDevForTest, _resetModelsDevForTest } from "../agent/models-dev.ts";
import { sleep } from "../testkit.ts";

import { APP_TOKEN_NAME, setup, createAndChat } from "./app-test-util.ts";

describe("app channel http", () => {
	test("create, list, and history ride the app pool only", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			// A telegram conversation in the same store must never surface.
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

			// Bad ids 404 — including a telegram-shaped id, which parses as an
			// app segment but resolves to nothing app-side.
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
		// 50ms deltas keep the turn alive well past the stop POST below.
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
			// The fenced turn's stream ends with an error chunk + [DONE].
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
			// No live turn: the SDK's reconnect contract expects 204 and
			// falls back to history.
			const idle = await call("/api/app/conversations/chat-01/stream");
			expect(idle.status).toBe(204);
			// Non-GET is refused.
			const wrongMethod = await call("/api/app/conversations/chat-01/stream", { method: "POST" });
			expect(wrongMethod.status).toBe(405);
			// Unknown conversation.
			const missing = await call("/api/app/conversations/nope/stream");
			expect(missing.status).toBe(404);
			// A live turn: attach mid-stream (deltas land every 60ms).
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
			const text = await res.text(); // resolves when the turn ends
			const events = text
				.split("\n\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice("data: ".length));
			expect(events.at(-1)).toBe("[DONE]");
			// The replay starts at the wire's first chunk — a reload sees
			// the reply from its beginning, not mid-sentence.
			expect(JSON.parse(events[0]!) as { type: string }).toMatchObject({ type: "start" });
			const types = events
				.filter((e) => e !== "[DONE]")
				.map((e) => (JSON.parse(e) as { type: string }).type);
			expect(types).toContain("text-delta");
			expect(types.filter((t) => t === "start")).toHaveLength(1); // no duplicate start from replay + tail
			await chatP;
		} finally {
			http.stop();
		}
	});

	// #79's server half: the client re-reads history when a reconnect
	// comes back idle, which is only sound because the 204 promises
	// durability — the runtime persists a turn's reply before it retires
	// the wire, so the moment the endpoint first says "nothing is live"
	// (after the turn was seen live), the completed answer is already in
	// the store. Pins that ordering at the HTTP boundary; a reorder
	// (append after the wire retires) opens a 204-without-reply window
	// this poll catches.
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
					await probe.body?.cancel(); // detach; keep polling
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
			// An operator title is explicit — the auto-title rule must
			// never overwrite it.
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

			// Nothing destructive: history and search survive the shelf.
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

			// Auto-unarchive: a submitted turn appends its user event and
			// the row comes back to the rail.
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

			// Shelving supersedes pinning: archiving clears the stamp.
			await patch({ archived: true });
			expect(store.get("app/chat-01")?.pinnedAt).toBeNull();

			// Pin-while-archived is a 409, not a written contradiction —
			// including the combined patch that archives and pins at once.
			const conflict = await patch({ pinned: true });
			expect(conflict.status).toBe(409);
			const combo = await patch({ archived: true, pinned: true });
			expect(combo.status).toBe(409);
			expect(store.get("app/chat-01")?.archivedAt).not.toBeNull();
			expect(store.get("app/chat-01")?.pinnedAt).toBeNull();

			// Unarchive+pin in one patch is the coherent form; unarchiving
			// alone never resurrects the cleared pin.
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
			// The FTS delete triggers kept the index honest.
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
			// The fenced turn's stream still terminates cleanly.
			const body = await chat.text();
			expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("search scopes to the app pool — telegram hits never leak", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			// Same term in both pools; only the app hit may come back.
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

			// A telegram-only term returns empty — the pool filter is on
			// the SQL side, not a post-filter that could under-fill.
			const tgOnly = (await (await call("/api/app/search?q=telegram")).json()) as {
				hits: unknown[];
			};
			expect(tgOnly.hits).toEqual([]);
			// Non-token queries are a clean empty, not a 500.
			expect((await call("/api/app/search?q=")).status).toBe(200);
			// An overlong q refuses — the log route's ruling, not a silent
			// truncation.
			expect((await call(`/api/app/search?q=${"x".repeat(257)}`)).status).toBe(400);
		} finally {
			http.stop();
		}
	});
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
		// No turns yet — utilization unknown, zero turns, limit still known.
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
		// One turn through the fake (input 1, output 2, no cache split).
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
