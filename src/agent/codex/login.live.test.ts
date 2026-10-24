// Live drift check for the ChatGPT device-code sign-in — run after a
// codex or auth.openai.com change pins down a moved interface:
//
//   GOBLIN_CODEX_LOGIN_LIVE=1 bun test src/agent/codex/login.live.test.ts
//
// This probes ONLY the usercode step: it creates one unused 15-minute
// pairing code on auth.openai.com and nothing else — no account is
// linked, no token is issued, nothing is persisted. Red means the
// usercode wire moved: re-check device_code_auth.rs and fix the adapter.

import { expect, test } from "bun:test";
import { OAUTH_CLIENT_ID } from "./auth.ts";

const LIVE = process.env.GOBLIN_CODEX_LOGIN_LIVE === "1";

test("deviceauth/usercode answers the pinned shape", async () => {
	if (!LIVE) return;
	const res = await fetch("https://auth.openai.com/api/accounts/deviceauth/usercode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
	});
	if (res.status === 404) {
		// Device login disabled for this client id — the flow itself is
		// gone; that's drift worth a red too, but say so plainly.
		throw new Error("deviceauth/usercode answered 404 — device login not enabled");
	}
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(Object.keys(body).sort()).toEqual([
		"device_auth_id",
		"expires_at",
		"interval",
		"user_code",
	]);
	expect(typeof body.device_auth_id).toBe("string");
	expect(typeof body.user_code).toBe("string");
	expect(["string", "number"]).toContain(typeof body.interval);
});
