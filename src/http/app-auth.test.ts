import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

describe("app channel browser-origin gate (trust mode, #75)", () => {
	// The attacker shape from the issue: a page on another origin in the
	// operator's own browser fires a no-cors POST (text/plain body — no
	// CORS preflight, response never read) at the tokenless app channel.
	// Bun's fetch sets no Origin/Sec-Fetch-Site of its own, so the plain
	// `call` helper elsewhere in this file is exactly the supported
	// non-browser client this gate must keep passing.
	const EVIL_ORIGIN = "http://attacker.local:1234";

	test("a cross-origin page cannot create conversations or submit turns", async () => {
		const { http, call, store } = setup({ token: undefined });
		try {
			// A legit (non-browser) client owns one conversation to aim at.
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

			// Attacker-chosen id creation: text/plain so no preflight fires.
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

			// The turn submission — the mutation that spends operator
			// authority on attacker-controlled input.
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
			// Nothing landed: no attacker turn in history.
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
			// tailscale serve rewrites Host to the local upstream
			// (docs/security.md) — the public origin is the match that
			// survives the proxy.
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

	test("a spoofed Host minting its own Origin match is refused (DNS rebinding)", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			// Attacker DNS points evil.example at our endpoint; both
			// Host and Origin name it — the old Host-echo made that
			// look same-origin. Only loopback Hosts may mint a match.
			const rebound = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						host: "evil.example:9999",
						origin: "http://evil.example:9999",
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "rebind-01" }),
				},
				null,
			);
			expect(rebound.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("an unrecognized Host-derived origin is refused once publicUrl is set", async () => {
		const { http, call, configRef } = setup({ token: undefined });
		try {
			configRef.current = {
				...configRef.current,
				publicUrl: "https://goblin.example.ts.net",
			} as Config;
			// The tailnet/local Host no longer mints its own match —
			// the pinned publicUrl is the only browser origin.
			const direct = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						origin: `http://127.0.0.1:${http.port}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "pinned-01" }),
				},
				null,
			);
			expect(direct.status).toBe(403);
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
			// No Origin at all, but the browser fetch-metadata header says
			// cross-site — belt for the Origin check.
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
			// A non-browser client (no Origin) with a text/plain body: the
			// origin gate has nothing to say — the content-type line does.
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
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin: EVIL_ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ id: "token-01" }),
				},
				// call() appends the valid bearer by default.
			);
			expect(created.status).toBe(201);
			// The content-type line still applies with a token, though.
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
