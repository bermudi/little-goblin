// 1min's relay truths, pinned to the operator-supplied docs
// (docs.1min.ai/docs/api/openai-compatible). The three facts this
// module owns: which baseUrl is the relay, that every chat attempt
// bills (so the SDK's default retry is a silent double charge), and —
// through carriesMedia in providers.ts — that the pipe is text-only.
// The thinking ladder lives in thinking.test.ts; the cache contract
// in the cache-contracts registry.

import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { isOneMinHost, isOneMinRoute, modelCallMaxRetries } from "./onemin.ts";

const providers: Config["providers"] = {
	onemin: {
		kind: "openai-compatible",
		baseUrl: "https://api.1min.ai/openai/v1",
		auth: "onemin",
	},
	other: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "other" },
	openrouter: { kind: "openrouter", auth: "openrouter" },
};

const cfg = { providers };

describe("isOneMinHost — the relay's own host", () => {
	test("the documented base URL matches, path-insensitively", () => {
		expect(isOneMinHost("https://api.1min.ai/openai/v1")).toBe(true);
		// The host is the identity — a path difference is still the relay.
		expect(isOneMinHost("https://api.1min.ai/openai/v2")).toBe(true);
	});
	test("look-alikes and other hosts do not", () => {
		expect(isOneMinHost("https://api.1min.ai.evil.test/v1")).toBe(false);
		expect(isOneMinHost("https://example.com/openai/v1")).toBe(false);
		expect(isOneMinHost(undefined)).toBe(false);
		expect(isOneMinHost("not a url")).toBe(false);
	});
});

describe("isOneMinRoute — ref → relay resolution", () => {
	test("a 1min provider ref resolves onto the relay", () => {
		expect(isOneMinRoute(cfg, "onemin/gpt-5.4")).toBe(true);
		// Slash-bearing model ids (moonshotai/kimi-k2.6) stay whole.
		expect(isOneMinRoute(cfg, "onemin/moonshotai/kimi-k2.6")).toBe(true);
	});
	test("other providers and unknown names do not", () => {
		expect(isOneMinRoute(cfg, "other/gpt-5.4")).toBe(false);
		expect(isOneMinRoute(cfg, "openrouter/openai/gpt-5.4")).toBe(false);
		expect(isOneMinRoute(cfg, "nobody/gpt-5.4")).toBe(false);
	});
});

describe("modelCallMaxRetries — 1min bills every attempt", () => {
	test("a 1min chat call carries no retry budget", () => {
		expect(modelCallMaxRetries(cfg, "onemin/gpt-5.4")).toBe(0);
	});
	test("every other route keeps the SDK default", () => {
		expect(modelCallMaxRetries(cfg, "other/gpt-5.4")).toBeUndefined();
		expect(modelCallMaxRetries(cfg, "openrouter/openai/gpt-5.4")).toBeUndefined();
		expect(modelCallMaxRetries(cfg, "nobody/gpt-5.4")).toBeUndefined();
	});
});
