import { expect, test } from "bun:test";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppActivityResponse } from "./app-wire.ts";
import { HeadlessSink, waitUntil } from "../testkit.ts";
import { userMessage } from "../runtime.ts";

test("activity is empty at idle and method/auth gates match app routes", async () => {
	const { http, call } = setup({ token: APP_TOKEN_NAME });
	try {
		const response = await call("/api/app/activity");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ busy: [], otherBusy: 0 } satisfies AppActivityResponse);
		const post = await call("/api/app/activity", { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("cache-control")).toContain("no-store");
		const unauthenticated = await call("/api/app/activity", {}, null);
		expect(unauthenticated.status).toBe(401);
	} finally {
		http.stop();
	}
});

test("activity lists a live app turn and removes it after settlement", async () => {
	const { http, call, runtime } = setup({ token: APP_TOKEN_NAME, deltas: ["one", "two", "three"], delayMs: 80 });
	try {
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "active-work", title: "Active work" }),
		});
		await call("/api/app/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: "app/active-work",
				message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
			}),
		});
		await waitUntil(() => runtime.busyConversations().includes("app/active-work"), "turn is busy");
		const live = await (await call("/api/app/activity")).json() as AppActivityResponse;
		expect(live.busy).toEqual([
			{ id: "app/active-work", title: "Active work", parentId: null, rolling: false },
		]);
		await waitUntil(async () => {
			const result = await (await call("/api/app/activity")).json() as AppActivityResponse;
			return result.busy.length === 0;
		}, "turn settles and leaves activity");
	} finally {
		http.stop();
	}
});

test("activity counts a live Telegram conversation without listing it", async () => {
	const { http, call, runtime, store, home } = setup({ token: APP_TOKEN_NAME, deltas: ["one", "two"], delayMs: 100 });
	try {
		const conversation = store.resolve({ kind: "dm", chatId: 42 }, home);
		runtime.submit(conversation, userMessage([{ type: "text", text: "hello" }]), new HeadlessSink());
		await waitUntil(() => runtime.busyConversations().includes(conversation.id), "Telegram turn is busy");
		const response = await (await call("/api/app/activity")).json() as AppActivityResponse;
		expect(response).toEqual({ busy: [], otherBusy: 1 });
	} finally {
		http.stop();
	}
});

test("activity lists a live Rolling chat turn", async () => {
	const { http, call, runtime, store, configRef } = setup({
		token: APP_TOKEN_NAME,
		deltas: ["one", "two", "three"],
		delayMs: 80,
	});
	try {
		const roll = store.rollApp(configRef.current);
		runtime.submit(roll, userMessage([{ type: "text", text: "hello" }]), new HeadlessSink());
		await waitUntil(() => runtime.busyConversations().includes(roll.id), "Rolling chat turn is busy");
		const live = await (await call("/api/app/activity")).json() as AppActivityResponse;
		expect(live).toEqual({
			busy: [{ id: roll.id, title: null, parentId: null, rolling: true }],
			otherBusy: 0,
		});
	} finally {
		http.stop();
	}
});
