import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

describe("app channel browser-origin gate (trust mode, #75)", () => {
	const EVIL_ORIGIN = "http://attacker.local:1234";

	test("a cross-origin page cannot create conversations or submit turns", async () => {
		const { http, call, store } = setup({ token: undefined });
		try {
			expect(
				(
					await call(
						"/api/app/conversations",
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id: "target-01" }),
						},
						null,
					)
				).status,
			).toBe(201);

			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin: EVIL_ORIGIN, "content-type": "text/plain" },
					body: JSON.stringify({ id: "pwned-01" }),
				},
				null,
			);
			expect(created.status).toBe(403);
			expect(store.get("app/pwned-01")).toBeNull();

			const chat = await call(
				"/api/app/chat",
				{
					method: "POST",
					headers: { origin: EVIL_ORIGIN, "content-type": "text/plain" },
					body: JSON.stringify({
						conversationId: "app/target-01",
						message: {
							id: "m-evil",
							role: "user",
							parts: [{ type: "text", text: "ATTACKER CONTROLLED INPUT" }],
						},
					}),
				},
				null,
			);
			expect(chat.status).toBe(403);
			await chat.text();
			expect(store.history("app/target-01")).toEqual([]);
		} finally {
			http.stop();
		}
	});

	test("a browser on our own origin still mutates — direct loopback", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const origin = `http://127.0.0.1:${http.port}`;
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ id: "same-origin-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
			const chat = await call(
				"/api/app/chat",
				{
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/same-origin-01",
						message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
					}),
				},
				null,
			);
			expect(chat.status).toBe(200);
			await chat.text();
		} finally {
			http.stop();
		}
	});

	test("a browser on the configured publicUrl origin passes behind a Host-rewriting front", async () => {
		const { http, call, configRef } = setup({ token: undefined });
		try {
			configRef.current = {
				...configRef.current,
				publicUrl: "https://goblin.example.ts.net",
			} as Config;
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						origin: "https://goblin.example.ts.net",
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "front-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
		} finally {
			http.stop();
		}
	});

	test("a browser whose Origin matches its own non-loopback Host passes (ruling #75 proxy compatibility)", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			// A front that preserves Host, or direct access via a tailnet
			// name: the browser's Origin names the Host it was served from
			// — the documented own-Host acceptance, loopback not required.
			// The DNS-rebinding residual this shape carries is explicitly
			// accepted in design/app.md (ruling 2026-10-08 #75); a stricter
			// pinned-origin policy would need its own ruling.
			const own = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						host: "goblin.tailnet.example:9999",
						origin: "http://goblin.tailnet.example:9999",
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "own-host-01" }),
				},
				null,
			);
			expect(own.status).toBe(201);
		} finally {
			http.stop();
		}
	});

	test("beside a configured publicUrl the own-Host origin still passes and a foreign origin is refused", async () => {
		const { http, call, configRef } = setup({ token: undefined });
		try {
			configRef.current = {
				...configRef.current,
				publicUrl: "https://goblin.example.ts.net",
			} as Config;
			// The ruling's union: own Host (either scheme) or the public
			// origin — publicUrl adds a door for Host-rewriting fronts,
			// it does not pin the policy to itself.
			const own = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						origin: `http://127.0.0.1:${http.port}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "own-beside-01" }),
				},
				null,
			);
			expect(own.status).toBe(201);
			const foreign = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						origin: "https://evil.example",
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "foreign-01" }),
				},
				null,
			);
			expect(foreign.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("an opaque origin (null) and Sec-Fetch-Site: cross-site are refused", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const opaque = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin: "null", "content-type": "application/json" },
					body: JSON.stringify({ id: "opaque-01" }),
				},
				null,
			);
			expect(opaque.status).toBe(403);
			const sfs = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
					body: JSON.stringify({ id: "sfs-01" }),
				},
				null,
			);
			expect(sfs.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("non-browser clients (no Origin, no Sec-Fetch-Site) pass in trust mode", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: "curl-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
		} finally {
			http.stop();
		}
	});

	test("JSON mutations must claim application/json — text/plain bodies refuse 415", async () => {
		const { http, call, store } = setup({ token: undefined });
		try {
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: JSON.stringify({ id: "plain-01" }),
				},
				null,
			);
			expect(created.status).toBe(415);
			expect(store.get("app/plain-01")).toBeNull();
		} finally {
			http.stop();
		}
	});

	test("a cross-origin multipart upload is refused", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "evil.bin");
			const res = await call(
				"/api/app/attachments",
				{ method: "POST", headers: { origin: EVIL_ORIGIN }, body: form },
				null,
			);
			expect(res.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("bearer mode is unaffected by browser origin — the token is the check", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await call("/api/app/conversations", {
				method: "POST",
				headers: { origin: EVIL_ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ id: "token-01" }),
			});
			expect(created.status).toBe(201);
			const plain = await call("/api/app/conversations", {
				method: "POST",
				headers: { origin: EVIL_ORIGIN, "content-type": "text/plain" },
				body: JSON.stringify({ id: "token-02" }),
			});
			expect(plain.status).toBe(415);
		} finally {
			http.stop();
		}
	});
});
