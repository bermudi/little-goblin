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
const fresh = () => String(Math.floor(Date.now() / 1000));

const refused = (data: string, token = TOKEN) => {
	const r = validateInitData(data, token, allowed);
	if (r.ok) throw new Error("expected refusal");
	return r.why;
};

describe("initData validation", () => {
	test("valid initData returns the user", () => {
		const data = makeInitData({ auth_date: fresh(), user: JSON.stringify({ id: 42 }) });
		expect(validateInitData(data, TOKEN, allowed)).toEqual({ ok: true, user: { id: 42 } });
	});

	test("missing hash is refused as no-hash", () => {
		const params = new URLSearchParams({ auth_date: fresh(), user: JSON.stringify({ id: 42 }) });
		expect(refused(params.toString())).toBe("no-hash");
		expect(refused("")).toBe("no-hash");
	});

	test("tampered fields fail the HMAC", () => {
		const data = makeInitData({ auth_date: fresh(), user: JSON.stringify({ id: 42 }) });
		const tampered = data.replace("42", "7");
		expect(refused(tampered)).toBe("bad-hmac");
	});

	test("wrong token fails", () => {
		const data = makeInitData({ auth_date: fresh(), user: JSON.stringify({ id: 42 }) });
		expect(refused(data, "other-token")).toBe("bad-hmac");
	});

	test("missing or non-numeric auth_date is refused as bad-auth-date", () => {
		expect(refused(makeInitData({ user: JSON.stringify({ id: 42 }) }))).toBe("bad-auth-date");
		expect(
			refused(makeInitData({ auth_date: "yesterday", user: JSON.stringify({ id: 42 }) })),
		).toBe("bad-auth-date");
	});

	test("allowed HMAC but disallowed user fails", () => {
		const data = makeInitData({ auth_date: fresh(), user: JSON.stringify({ id: 99 }) });
		expect(refused(data)).toBe("not-operator");
	});

	test("missing or malformed user payload is refused before the operator check", () => {
		expect(refused(makeInitData({ auth_date: fresh() }))).toBe("no-user");
		expect(refused(makeInitData({ auth_date: fresh(), user: "{oops" }))).toBe("bad-user");
		// A payload without an id parses to 0 — not malformed, just not an operator.
		expect(refused(makeInitData({ auth_date: fresh(), user: "{}" }))).toBe("not-operator");
	});

	test("stale auth_date fails", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000) - 90000),
			user: JSON.stringify({ id: 42 }),
		});
		expect(refused(data)).toBe("stale");
	});

	test("auth_date far in the future fails", () => {
		const data = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000) + 3600),
			user: JSON.stringify({ id: 42 }),
		});
		expect(refused(data)).toBe("future");
	});
});
