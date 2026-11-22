import { describe, expect, test } from "bun:test";
import { compactTriggerTokens } from "./compact-trigger.ts";

describe("compactTriggerTokens — design/compaction.md → Triggers", () => {
	test("windows over 300k fire at the 272k cap; the rest at the window minus the reserve", () => {
		expect(compactTriggerTokens(1_100_000, false)).toBe(272_000);
		expect(compactTriggerTokens(300_001, false)).toBe(272_000);
		expect(compactTriggerTokens(300_000, false)).toBe(300_000 - 16_384);
		expect(compactTriggerTokens(200_000, false)).toBe(200_000 - 16_384);
		expect(compactTriggerTokens(undefined, false)).toBe(272_000);
		expect(compactTriggerTokens(null, false)).toBe(272_000);
	});

	test("an uncapped agent type fires at the window minus the reserve at any size", () => {
		expect(compactTriggerTokens(1_100_000, true)).toBe(1_100_000 - 16_384);
		expect(compactTriggerTokens(200_000, true)).toBe(200_000 - 16_384);
		expect(compactTriggerTokens(undefined, true)).toBe(272_000);
	});

	test("windows under twice the reserve fire at half the window", () => {
		expect(compactTriggerTokens(32_768, false)).toBe(16_384);
		expect(compactTriggerTokens(8_000, false)).toBe(4_000);
		expect(compactTriggerTokens(8_000, true)).toBe(4_000);
	});
});
