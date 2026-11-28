import { describe, expect, test } from "bun:test";
import type { PassRef } from "../../pass.ts";
import { passFillTool, type PassFillDeps } from "./pass-fill.ts";
import { setLogFile } from "../../log.ts";

setLogFile(null);

const SECRET = "SECRET-pw-123";

interface Rig {
	tool: ReturnType<typeof passFillTool>;
	laneCalls: { ref: PassRef; reason: string }[];
	fillCalls: { target: string; text: string; session: string | undefined }[];
	set: {
		pageUrl(value: string): void;
		urls(value: string | Error): void;
		value(value: string | Error): void;
		fillResult(result: { ok: true } | { ok: false; error: string }): void;
	};
}

function rig(): Rig {
	const laneCalls: Rig["laneCalls"] = [];
	const fillCalls: Rig["fillCalls"] = [];
	let pageUrl = "https://example.com/login";
	let urls: string | Error = "https://example.com";
	let value: string | Error = SECRET;
	let fillResult: { ok: true } | { ok: false; error: string } = { ok: true };
	const deps: PassFillDeps = {
		lane: {
			readField: async (ref: PassRef, reason: string) => {
				laneCalls.push({ ref, reason });
				if (ref.field === "urls") {
					if (urls instanceof Error) throw urls;
					return urls;
				}
				if (value instanceof Error) throw value;
				return value;
			},
		},
		browser: {
			pageUrl: async () => pageUrl,
			fill: async (target: string, text: string, session?: string) => {
				fillCalls.push({ target, text, session });
				return fillResult;
			},
		},
	};
	return {
		tool: passFillTool(deps),
		laneCalls,
		fillCalls,
		set: {
			pageUrl: (v) => (pageUrl = v),
			urls: (v) => (urls = v),
			value: (v) => (value = v),
			fillResult: (v) => (fillResult = v),
		},
	};
}

const REF = "pass://share9/item7/password";
const run = (tool: ReturnType<typeof passFillTool>, input: Record<string, unknown>) =>
	tool.execute({ ref: REF, target: "#pw", ...input } as never, { toolCallId: "t" });

describe("pass_fill", () => {
	test("fills the field and reports only the fill, never the value", async () => {
		const r = rig();
		const result = await run(r.tool, { session: "work" });
		expect(result).toEqual({ filled: true, field: "password", host: "example.com" });
		expect(r.fillCalls).toEqual([{ target: "#pw", text: SECRET, session: "work" }]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(r.laneCalls.map((c) => c.ref.field)).toEqual(["urls", "password"]);
		expect(r.laneCalls[0]!.reason).toBe("goblin pass_fill: password for example.com");
	});

	test("a subdomain of a saved website matches", async () => {
		const r = rig();
		r.set.pageUrl("https://app.example.com/login");
		const result = await run(r.tool, {});
		expect(result).toEqual({ filled: true, field: "password", host: "app.example.com" });
	});

	test("a bare hostname entry in urls matches", async () => {
		const r = rig();
		r.set.urls("example.com");
		expect(await run(r.tool, {})).toEqual({ filled: true, field: "password", host: "example.com" });
	});

	test("host mismatch refuses before the value is read", async () => {
		const r = rig();
		r.set.urls("https://other.example.org");
		const result = await run(r.tool, {});
		expect(result).toMatchObject({
			error: "page host example.com is not one of the item's websites (other.example.org)",
		});
		expect(r.laneCalls.map((c) => c.ref.field)).toEqual(["urls"]);
		expect(r.fillCalls).toEqual([]);
	});

	test("an item without websites names the fix and never reads the value", async () => {
		const r = rig();
		r.set.urls(new Error("Field does not exist: urls"));
		const result = await run(r.tool, {});
		expect(result).toMatchObject({ error: expect.stringContaining("no website address") });
		expect(r.laneCalls.map((c) => c.ref.field)).toEqual(["urls"]);
		expect(r.fillCalls).toEqual([]);
	});

	test("plain http off loopback is refused before any read", async () => {
		const r = rig();
		r.set.pageUrl("http://example.com/login");
		const result = await run(r.tool, {});
		expect(result).toMatchObject({ error: expect.stringContaining("only fills over https") });
		expect(r.laneCalls).toEqual([]);
	});

	test("http on loopback fills", async () => {
		const r = rig();
		r.set.pageUrl("http://127.0.0.1:8080/login");
		r.set.urls("http://127.0.0.1");
		expect(await run(r.tool, {})).toEqual({ filled: true, field: "password", host: "127.0.0.1" });
	});

	test.each(["urls", "totp_uri", "URLS", "TOTP_URI"])("the %s field is refused", async (field) => {
		const r = rig();
		const result = await run(r.tool, { ref: `pass://share9/item7/${field}` });
		expect(result).toMatchObject({ error: expect.stringContaining("can't be filled") });
		expect(r.laneCalls).toEqual([]);
	});

	test.each(["not-a-ref", "pass://a/b", "pass://a/b/c?totp=uri", "pass://a/b/"])(
		"invalid ref %s is refused without touching deps",
		async (ref) => {
			const r = rig();
			const result = await run(r.tool, { ref });
			expect(result).toMatchObject({ error: expect.stringContaining("pass://VAULT/ITEM/FIELD") });
			expect(r.laneCalls).toEqual([]);
			expect(r.fillCalls).toEqual([]);
		},
	);

	test("an empty field reports empty without a fill", async () => {
		const r = rig();
		r.set.value("");
		const result = await run(r.tool, {});
		expect(result).toEqual({ error: "that field is empty" });
		expect(r.fillCalls).toEqual([]);
	});

	test("a fill error that echoes the value comes back hidden", async () => {
		const r = rig();
		r.set.fillResult({ ok: false, error: `could not fill, the text ${SECRET} was rejected by ${SECRET}` });
		const result = await run(r.tool, {});
		expect(result).toEqual({ error: "could not fill, the text [hidden] was rejected by [hidden]" });
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	test("a session name is validated by the input schema", () => {
		const r = rig();
		const bad = r.tool.input.safeParse({ ref: REF, target: "#pw", session: "bad session!" });
		expect(bad.success).toBe(false);
		expect(r.tool.input.safeParse({ ref: REF, target: "#pw", session: "work-2" }).success).toBe(true);
		expect(r.tool.input.safeParse({ ref: REF, target: "#pw", extra: 1 }).success).toBe(false);
	});
});
