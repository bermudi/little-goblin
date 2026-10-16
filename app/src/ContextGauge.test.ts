// The context gauge's label contract — pure formatting over the
// server's AppContextView, no DOM. Pins the composer's one-line
// readout so a refactor can't silently change what the operator reads.
import { describe, expect, test } from "bun:test";
import { contextCount, contextLabel } from "./ChatView.tsx";
import type { AppContextView } from "../../src/http/app-wire.ts";

const view = (patch: Partial<AppContextView>): AppContextView => ({
	model: "test/m",
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	cacheHitRate: null,
	avgCacheHitRate: null,
	limit: null,
	pct: null,
	turns: 0,
	...patch,
});

describe("context gauge labels", () => {
	test("counts stay raw below a thousand, compact above it", () => {
		expect(contextCount(340)).toBe("340");
		expect(contextCount(1500)).toBe("1.5k");
		expect(contextCount(104321)).toBe("104.3k");
		expect(contextCount(1000000)).toBe("1.0M");
	});

	test("a fresh conversation names itself instead of showing zeros", () => {
		expect(contextLabel(null)).toBe("…");
		expect(contextLabel(view({ turns: 0 }))).toBe("no turns yet");
	});

	test("the settled label carries input, limit, and percent", () => {
		expect(contextLabel(view({ input: 104321, limit: 1000000, pct: 10.4, turns: 3 }))).toBe(
			"104.3k/1.0M · 10.4%",
		);
	});

	test("an unlisted model still shows the input count", () => {
		expect(contextLabel(view({ input: 512, limit: null, turns: 1 }))).toBe("512 tok");
	});

	test("turns without usable counts read as unknown, not zero", () => {
		expect(contextLabel(view({ input: null, turns: 2 }))).toBe("ctx ?");
	});
});
