import { describe, expect, test } from "bun:test";
import { isHttpUrl } from "./url.ts";

// The gate every untrusted anchor shares — the point is the refusal
// set: a deduped predicate must not quietly start accepting what the
// per-site regexes rejected.
describe("isHttpUrl", () => {
	test("plain http and https URLs anchor", () => {
		expect(isHttpUrl("https://example.com")).toBe(true);
		expect(isHttpUrl("http://example.com/a?q=1#frag")).toBe(true);
		expect(isHttpUrl("https://user:pw@example.com:8443/x")).toBe(true);
	});

	test("non-http(s) schemes never anchor", () => {
		expect(isHttpUrl("javascript:alert(1)")).toBe(false);
		expect(isHttpUrl("data:text/html;base64,PGI+")).toBe(false);
		expect(isHttpUrl("file:///etc/passwd")).toBe(false);
		expect(isHttpUrl("ftp://example.com")).toBe(false);
		expect(isHttpUrl("mailto:a@b.c")).toBe(false);
		expect(isHttpUrl("vbscript:x")).toBe(false);
	});

	test("forms the URL parser would normalize stay refused", () => {
		expect(isHttpUrl("HTTPS://example.com")).toBe(false); // case-sensitive gate
		expect(isHttpUrl("https:example.com")).toBe(false); // no slashes
		expect(isHttpUrl("//example.com")).toBe(false); // scheme-relative
		expect(isHttpUrl(" https://example.com")).toBe(false); // padded
	});

	test("malformed strings render as text, not a dead href", () => {
		expect(isHttpUrl("")).toBe(false);
		expect(isHttpUrl("https://")).toBe(false);
		expect(isHttpUrl("https://[unclosed")).toBe(false);
		expect(isHttpUrl("http://example .com")).toBe(false);
		expect(isHttpUrl("not a url")).toBe(false);
	});
});
