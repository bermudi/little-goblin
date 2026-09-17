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

describe("initData validation", () => {
	test("valid initData returns the user", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 42 }),
		});
		expect(validateInitData(data, TOKEN, allowed)).toEqual({ id: 42 });
	});

	test("tampered fields fail the HMAC", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 42 }),
		});
		const tampered = data.replace("42", "7");
		expect(validateInitData(tampered, TOKEN, allowed)).toBeNull();
	});

	test("wrong token fails", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 42 }),
		});
		expect(validateInitData(data, "other-token", allowed)).toBeNull();
	});

	test("allowed HMAC but disallowed user fails", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 99 }),
		});
		expect(validateInitData(data, TOKEN, allowed)).toBeNull();
	});

	test("stale auth_date fails", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000) - 90000),
			user: JSON.stringify({ id: 42 }),
		});
		expect(validateInitData(data, TOKEN, allowed)).toBeNull();
	});
});
