import { describe, expect, test } from "bun:test";
import { APP_PUSH_VAPID, openAppPush } from "../app-push.ts";
import type { AppPushStatus } from "./app-wire.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

const SUBSCRIPTION = {
	endpoint: "https://push.example.test/registrations/device-1",
	expirationTime: null,
	keys: { p256dh: "device-p256dh", auth: "device-auth" },
};

function wired() {
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
	const { http, call, store, appDeps } = setup({ token: APP_TOKEN_NAME });
	appDeps.push = openAppPush(store.db, {
		auth,
		storeSecret: (name, value) => authValues.set(name, value),
		store,
		subject: () => "mailto:goblin@example.test",
		generateKeys: () => ({ publicKey: "public-vapid", privateKey: "private-vapid" }),
	});
	return { http, call, authValues };
}

describe("app push routes", () => {
	test("status, public key, register/replace, and unregister stay authenticated and secret-free", async () => {
		const { http, call, authValues } = wired();
		try {
			expect((await call("/api/app/push")).status).toBe(200);
			const initial = (await (await call("/api/app/push")).json()) as AppPushStatus;
			expect(initial).toEqual({ configured: false, subscriptions: [] });

			const unauth = await call("/api/app/push", {}, null);
			expect(unauth.status).toBe(401);

			const nonJsonKey = await call("/api/app/push/public-key", { method: "POST" });
			expect(nonJsonKey.status).toBe(415);
			expect(authValues.has(APP_PUSH_VAPID)).toBe(false);

			const key = await call("/api/app/push/public-key", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(key.status).toBe(200);
			const keyBody = (await key.json()) as { publicKey: string };
			expect(keyBody).toEqual({ publicKey: "public-vapid" });
			expect(authValues.has(APP_PUSH_VAPID)).toBe(true);
			expect(JSON.stringify(keyBody)).not.toContain("private-vapid");

			const invalid = await call("/api/app/push/subscription", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ endpoint: "not-a-url", keys: {} }),
			});
			expect(invalid.status).toBe(400);
			const insecure = await call("/api/app/push/subscription", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...SUBSCRIPTION,
					endpoint: "http://push.example.test/registrations/device-1",
				}),
			});
			expect(insecure.status).toBe(400);

			const register = await call("/api/app/push/subscription", {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": "browser-test/1" },
				body: JSON.stringify(SUBSCRIPTION),
			});
			expect(register.status).toBe(200);
			const registered = (await register.json()) as { endpointHash: string };
			expect(registered.endpointHash).toMatch(/^[0-9a-f]{64}$/);

			const replace = await call("/api/app/push/subscription", {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": "browser-test/2" },
				body: JSON.stringify({ ...SUBSCRIPTION, expirationTime: 55 }),
			});
			expect(replace.status).toBe(200);

			const statusRes = await call("/api/app/push");
			const status = (await statusRes.json()) as AppPushStatus;
			expect(status.configured).toBe(true);
			expect(status.subscriptions).toHaveLength(1);
			expect(status.subscriptions[0]).toMatchObject({
				endpointHash: registered.endpointHash,
				userAgent: "browser-test/2",
			});
			expect(JSON.stringify(status)).not.toContain(SUBSCRIPTION.endpoint);
			expect(JSON.stringify(status)).not.toContain("device-auth");

			const removed = await call("/api/app/push/subscription", {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ endpoint: SUBSCRIPTION.endpoint }),
			});
			expect(removed.status).toBe(200);
			expect(await removed.json()).toEqual({ removed: true });
		} finally {
			http.stop();
		}
	});

	test("the route fails closed when the owner is not wired", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await call("/api/app/push");
			expect(res.status).toBe(503);
		} finally {
			http.stop();
		}
	});
});
