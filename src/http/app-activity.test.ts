import { expect, test } from "bun:test";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppActivityResponse } from "./app-wire.ts";
import { HeadlessSink, waitUntil } from "../testkit.ts";
import { userMessage } from "../runtime.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import { postTool } from "../agent/tools/post.ts";
import { POSTS_KEPT } from "../posts.ts";

test("activity is empty at idle and method/auth gates match app routes", async () => {
	const { http, call } = setup({ token: APP_TOKEN_NAME });
	try {
		const response = await call("/api/app/activity");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ busy: [], otherBusy: 0, posts: [] } satisfies AppActivityResponse);
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
		expect(response).toEqual({ busy: [], otherBusy: 1, posts: [] });
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
			posts: [],
		});
	} finally {
		http.stop();
	}
});

test("a post the model makes in an app chat shows in activity and links to that chat", async () => {
	const model = sdkScript();
	model.script(
		{ kind: "reply", parts: [{ type: "tool-call", toolName: "post", input: { text: "  Backup finished.\nAll 3 disks OK.  " } }] },
		{ kind: "reply", parts: [{ type: "text", text: "posted" }] },
	);
	const rig: ReturnType<typeof setup> = setup({
		token: APP_TOKEN_NAME,
		scriptedModel: model,
		makeTools: (conv) => ({ post: postTool({ posts: rig.posts, conversationId: conv.id }) }),
	});
	const { http, call, runtime } = rig;
	try {
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "nightly", title: "Nightly" }),
		});
		await call("/api/app/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: "app/nightly",
				message: { id: "m1", role: "user", parts: [{ type: "text", text: "post it" }] },
			}),
		});
		await waitUntil(() => model.calls() === 2 && runtime.busyConversations().length === 0, "turn settles");
		const result = await (await call("/api/app/activity")).json() as AppActivityResponse;
		expect(result.posts).toHaveLength(1);
		expect(result.posts[0]).toMatchObject({ id: 1, text: "Backup finished.\nAll 3 disks OK.", conversation: { id: "app/nightly", rolling: false } });
		expect(Number.isNaN(Date.parse(result.posts[0]!.createdAt))).toBe(false);
	} finally {
		http.stop();
	}
});

test("activity lists posts newest first, keeps a capped history and links only to app chats that exist", async () => {
	const { http, call, posts, store, home, configRef } = setup({ token: APP_TOKEN_NAME });
	try {
		const telegram = store.resolve({ kind: "dm", chatId: 42 }, home);
		posts.add({ conversationId: telegram.id, text: "from telegram" });
		posts.add({ conversationId: "app/gone", text: "from a chat that does not exist" });
		for (let i = 0; i < POSTS_KEPT; i += 1) posts.add({ conversationId: telegram.id, text: `post ${i}` });
		posts.add({ conversationId: "app/gone", text: "gone again" });
		const roll = store.rollApp(configRef.current);
		posts.add({ conversationId: roll.id, text: "from the Goblin chat" });
		const result = await (await call("/api/app/activity")).json() as AppActivityResponse;
		expect(result.posts).toHaveLength(20);
		expect(result.posts.slice(0, 3)).toMatchObject([
			{ text: "from the Goblin chat", conversation: { id: roll.id, rolling: true } },
			{ text: "gone again", conversation: null },
			{ text: `post ${POSTS_KEPT - 1}`, conversation: null },
		]);
		expect(result.posts.map((p) => p.id)).toEqual([...result.posts.map((p) => p.id)].sort((a, b) => b - a));
		const kept = store.db.query<{ n: number; oldest: string }, []>(
			"SELECT COUNT(*) AS n, (SELECT text FROM posts ORDER BY id LIMIT 1) AS oldest FROM posts",
		).get();
		expect(kept).toEqual({ n: POSTS_KEPT, oldest: "post 2" });
	} finally {
		http.stop();
	}
});
