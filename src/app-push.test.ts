import { describe, expect, test } from "bun:test";
import type { SendResult } from "web-push";
import { APP_PUSH_VAPID, openAppPush } from "./app-push.ts";
import { appAddress, openStore } from "./conversation.ts";
import type { TurnDone } from "./runtime.ts";
import { openTestStore } from "./testkit.ts";

const SUBSCRIPTION = {
	endpoint: "https://push.example.test/registrations/endpoint-1",
	expirationTime: null,
	keys: { p256dh: "browser-p256dh", auth: "browser-auth" },
};

const OK: SendResult = { statusCode: 201, body: "", headers: {} };

function fixture(opts: {
	send?: (
		subscription: { endpoint: string },
		payload: string,
		options: { topic?: string | undefined },
	) => Promise<SendResult>;
	generateKeys?: () => { publicKey: string; privateKey: string };
}) {
	const { store } = openTestStore("goblin-push-");
	const authValues = new Map<string, string>();
	const auth = {
		has: (name: string) => authValues.has(name),
		resolve: (name: string) => {
			const value = authValues.get(name);
			return value === undefined
				? Promise.reject(new Error(`no such auth record: ${name}`))
				: Promise.resolve(value);
		},
	};
	const generateCalls: string[] = [];
	const push = openAppPush(store.db, {
		auth,
		storeSecret: (name, value) => authValues.set(name, value),
		store,
		subject: () => "mailto:goblin@example.test",
		generateKeys: () => {
			generateCalls.push(APP_PUSH_VAPID);
			return (
				opts.generateKeys?.() ?? {
					publicKey: "generated-public",
					privateKey: "generated-private",
				}
			);
		},
		...(opts.send !== undefined
			? {
					send: (subscription, payload, options) => opts.send!(subscription, payload, options),
				}
			: {}),
	});
	return { store, push, authValues, generateCalls };
}

function seedReply(store: ReturnType<typeof fixture>["store"], id = "push-room") {
	const conv = store.resolve(appAddress(id), "/w");
	store.append(conv.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "run this" }] }]);
	store.append(
		conv.id,
		[{ id: "a1", role: "assistant", parts: [{ type: "text", text: "secret reply text" }] }],
		{ anchorSeq: 1 },
	);
	return conv;
}

describe("app push owner", () => {
	test("creates the VAPID pair lazily and reuses it across owner instances", async () => {
		const { store, push, authValues, generateCalls } = fixture({});

		expect(await push.status()).toMatchObject({ configured: false, subscriptions: [] });
		expect(generateCalls).toHaveLength(0);
		expect(await push.ensurePublicKey()).toBe("generated-public");
		expect(generateCalls).toEqual([APP_PUSH_VAPID]);
		expect(JSON.parse(authValues.get(APP_PUSH_VAPID)!)).toMatchObject({
			publicKey: "generated-public",
		});

		const second = openAppPush(store.db, {
			auth: {
				has: (name) => authValues.has(name),
				resolve: (name) => Promise.resolve(authValues.get(name)!),
			},
			storeSecret: (name, value) => authValues.set(name, value),
			store,
			subject: () => "mailto:goblin@example.test",
			generateKeys: () => {
				generateCalls.push(APP_PUSH_VAPID);
				return { publicKey: "other-public", privateKey: "other-private" };
			},
		});
		expect(await second.ensurePublicKey()).toBe("generated-public");
		expect(generateCalls).toHaveLength(1);
	});

	test("registers, replaces, hashes, and removes a device subscription", async () => {
		const { push } = fixture({});
		const first = await push.register(SUBSCRIPTION, "agent/1");
		const second = await push.register({ ...SUBSCRIPTION, expirationTime: 123 }, "agent/2");
		expect(second.endpointHash).toBe(first.endpointHash);

		const status = await push.status();
		expect(status.subscriptions).toHaveLength(1);
		expect(status.subscriptions[0]).toMatchObject({
			endpointHash: first.endpointHash,
			userAgent: "agent/2",
		});
		expect(JSON.stringify(status)).not.toContain(SUBSCRIPTION.endpoint);
		expect(JSON.stringify(status)).not.toContain("browser-auth");

		expect(push.unregister(SUBSCRIPTION.endpoint)).toBe(true);
		expect(push.unregister(SUBSCRIPTION.endpoint)).toBe(false);
		expect(await push.status()).toMatchObject({ subscriptions: [] });
	});

	test("sends a generic terminal notification once per durable reply and endpoint", async () => {
		const calls: {
			endpoint: string;
			body: Record<string, unknown>;
			topic: string | undefined;
		}[] = [];
		const { store, push } = fixture({
			send: (subscription, payload, options) => {
				calls.push({
					endpoint: subscription.endpoint,
					body: JSON.parse(payload) as Record<string, unknown>,
					topic: options.topic,
				});
				return Promise.resolve(OK);
			},
		});
		const conv = seedReply(store);
		await push.register(SUBSCRIPTION, null);

		const done: TurnDone = { kind: "completed" };
		await push.notifyDone(conv, done);
		await push.notifyDone(conv, done);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.endpoint).toBe(SUBSCRIPTION.endpoint);
		expect(calls[0]!.body).toMatchObject({
			title: "goblin",
			body: "A background turn finished",
			url: "/app/c/push-room",
		});
		expect(calls[0]!.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
		expect(JSON.stringify(calls[0]!.body)).not.toContain("secret reply text");
	});

	test("a transient send failure stays retryable while a delivered endpoint stays deduped", async () => {
		const calls: { endpoint: string; tag: unknown }[] = [];
		let fail = true;
		const { store, push } = fixture({
			send: (subscription, payload) => {
				const body = JSON.parse(payload) as { tag?: unknown };
				calls.push({ endpoint: subscription.endpoint, tag: body.tag });
				return fail
					? Promise.reject(Object.assign(new Error("temporary"), { statusCode: 503 }))
					: Promise.resolve(OK);
			},
		});
		const conv = seedReply(store, "retry-room");
		await push.register(SUBSCRIPTION, null);
		const done: TurnDone = { kind: "completed" };

		await push.notifyDone(conv, done);
		store.append(
			conv.id,
			[{ id: "a2", role: "assistant", parts: [{ type: "text", text: "newer" }] }],
			{ anchorSeq: 1 },
		);
		fail = false;
		await push.notifyDone(conv, done);
		await push.notifyDone(conv, done);

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.endpoint)).toEqual([
			SUBSCRIPTION.endpoint,
			SUBSCRIPTION.endpoint,
		]);
		expect(calls[1]!.tag).toBe(calls[0]!.tag);
	});

	test("a gone endpoint is pruned; an unrelated failure is retained", async () => {
		const calls: string[] = [];
		const { store, push } = fixture({
			send: (subscription) => {
				calls.push(subscription.endpoint);
				return Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }));
			},
		});
		const conv = seedReply(store, "gone-room");
		await push.register(SUBSCRIPTION, null);

		await push.notifyDone(conv, { kind: "completed" });
		expect(await push.status()).toMatchObject({ subscriptions: [] });

		const secondEndpoint = {
			...SUBSCRIPTION,
			endpoint: "https://push.example.test/registrations/endpoint-2",
		};
		await push.register(secondEndpoint, null);
		const retained = openAppPush(store.db, {
			auth: {
				has: () => true,
				resolve: () =>
					Promise.resolve(JSON.stringify({ publicKey: "public", privateKey: "private" })),
			},
			store,
			subject: () => "mailto:goblin@example.test",
			send: () => Promise.reject(Object.assign(new Error("temporary"), { statusCode: 503 })),
		});
		const done: TurnDone = { kind: "error", message: "provider down" };
		await retained.notifyDone(conv, done);
		expect((await retained.status()).subscriptions).toHaveLength(1);
	});

	test("fenced turns and deleted conversations stay silent", async () => {
		const calls: string[] = [];
		const { store, push } = fixture({
			send: (subscription) => {
				calls.push(subscription.endpoint);
				return Promise.resolve(OK);
			},
		});
		const conv = seedReply(store, "quiet-room");
		await push.register(SUBSCRIPTION, null);

		await push.notifyDone(conv, { kind: "fenced" });
		store.deleteConversation(conv.id);
		await push.notifyDone(conv, { kind: "completed" });

		expect(calls).toEqual([]);
	});
});
