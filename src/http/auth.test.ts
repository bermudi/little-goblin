import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { validateInitData } from "./auth.ts";

const TOKEN = "test-bot-token";

function makeInitData(fields: Record<string, string>): string {
	const params = new URLSearchParams(fields);
	const checkString = [...params.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
	const hash = createHmac("sha256", secret).update(checkString).digest("hex");
	params.set("hash", hash);
	return params.toString();
}

const allowed = new Set([42]);
const nowSeconds = Math.floor(Date.now() / 1000);
const signedUser = (id = 42, authDate = nowSeconds) =>
	makeInitData({ auth_date: String(authDate), user: JSON.stringify({ id }) });
const tamperedUser = new URLSearchParams(signedUser());
tamperedUser.set("user", JSON.stringify({ id: 7 }));

type RejectedCase = readonly [name: string, data: string, token: string, operators: Set<number>];
const rejectedCases: RejectedCase[] = [
	["tampered fields fail the HMAC", tamperedUser.toString(), TOKEN, allowed],
	["wrong token fails", signedUser(), "other-token", allowed],
	["allowed HMAC but disallowed user fails", signedUser(99), TOKEN, allowed],
	["stale auth_date fails", signedUser(42, nowSeconds - 90_000), TOKEN, allowed],
	["auth_date far in the future fails", signedUser(42, nowSeconds + 3600), TOKEN, allowed],
];

describe("initData validation", () => {
	test("valid initData returns the user", () => {
		expect(validateInitData(signedUser(), TOKEN, allowed)).toEqual({ id: 42 });
	});

	for (const [name, data, token, operators] of rejectedCases) {
		test(name, () => {
			expect(validateInitData(data, token, operators)).toBeNull();
		});
	}
});
