import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppAuth } from "./app-channel.ts";
import { setLogFile } from "../log.ts";
import { useHome } from "../testkit.ts";

import { APP_TOKEN_NAME, setup } from "./app-test-util.ts";

describe("app channel http", () => {
	test("boot resolution logs the auth mode — trust mode warns about funnel", () => {
		const home = useHome("goblin-app-");
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			expect(resolveAppAuth(undefined)).toBeUndefined();
			expect(resolveAppAuth(APP_TOKEN_NAME)).toBe(APP_TOKEN_NAME);
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as { level: string; msg: string });
			expect(
				lines.some(
					(l) =>
						l.level === "warn" && l.msg === "app channel auth: trust mode (no token; tailnet only)",
				),
			).toBe(true);
			expect(lines.some((l) => l.level === "warn" && l.msg.includes("funnel"))).toBe(true);
			expect(
				lines.some((l) => l.level === "info" && l.msg === "app channel auth: token required"),
			).toBe(true);
		} finally {
			setLogFile(null);
		}
	});

	test("unset appToken is trust mode — /api/app/* serves unauthenticated", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			// No Authorization header at all — and a stray bearer is
			// ignored too: there is nothing to check it against.
			expect((await call("/api/app/conversations", {}, null)).status).toBe(200);
			expect((await call("/api/app/conversations", {}, "bogus")).status).toBe(200);
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: "trust-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
			expect((await call("/api/app/conversations/trust-01/messages", {}, null)).status).toBe(200);
			const chat = await call(
				"/api/app/chat",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/trust-01",
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

	test("an unwired surface refuses identically", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME, wireApp: false });
		try {
			const res = await call("/api/app/conversations");
			expect(res.status).toBe(503);
		} finally {
			http.stop();
		}
	});

	test("bearer auth gates every route — absent, wrong, right", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/conversations", {}, null)).status).toBe(401);
			expect((await call("/api/app/conversations", {}, "wrong-token")).status).toBe(401);
			expect((await call("/api/app/conversations")).status).toBe(200);
		} finally {
			http.stop();
		}
	});

	test("the auth mode is boot-pinned — a mid-run appToken flip does not apply", async () => {
		const { http, call, configRef } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/conversations")).status).toBe(200);
			configRef.current = { ...configRef.current, appToken: undefined };
			// Live config now says trust, but the mode resolved at boot
			// owns the gate: bare requests stay refused until a restart.
			expect((await call("/api/app/conversations", {}, null)).status).toBe(401);
			expect((await call("/api/app/conversations")).status).toBe(200);
		} finally {
			http.stop();
		}
	});
});
