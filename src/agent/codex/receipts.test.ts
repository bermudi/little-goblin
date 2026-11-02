import { describe, expect, test } from "bun:test";
import { quotaFromEvent, quotaFromHeaders, quotaFromMetadata } from "./receipts.ts";

const heads = (h: Record<string, string>) => new Headers(h);

describe("quotaFromHeaders", () => {
	test("parses the default family; missing numbers null the window, not the quota", () => {
		expect(
			quotaFromHeaders(
				heads({
					"x-codex-primary-used-percent": "12.5",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": "1730000000",
					"x-codex-limit-name": "codex",
				}),
			),
		).toEqual({
			limitName: "codex",
			primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1730000000 },
			secondary: null,
		});
		// used_percent is the window's signal — without it there is no window.
		expect(
			quotaFromHeaders(heads({ "x-codex-primary-window-minutes": "300" })),
		).toBeNull();
		expect(
			quotaFromHeaders(
				heads({ "x-codex-secondary-used-percent": "3" }),
			),
		).toEqual({
			limitName: null,
			primary: null,
			secondary: { usedPercent: 3, windowMinutes: null, resetsAt: null },
		});
	});
});

describe("quotaFromEvent", () => {
	test("parses the wire shape; malformed events are not receipts", () => {
		expect(
			quotaFromEvent({
				type: "codex.rate_limits",
				rate_limits: {
					primary: { used_percent: 50, window_minutes: 300 },
					secondary: { used_percent: 1 },
				},
				limit_name: "x",
			}),
		).toEqual({
			limitName: "x",
			primary: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
			secondary: { usedPercent: 1, windowMinutes: null, resetsAt: null },
		});
		expect(quotaFromEvent({ type: "codex.rate_limits" })).toBeNull();
		expect(quotaFromEvent({ type: "other" })).toBeNull();
	});
});

describe("quotaFromMetadata", () => {
	test("reads the codex namespace's validated quota and nothing else", () => {
		expect(
			quotaFromMetadata({
				codex: {
					quota: {
						limitName: null,
						primary: { usedPercent: 9, windowMinutes: 300, resetsAt: null },
						secondary: null,
					},
				},
			}),
		).toEqual({
			limitName: null,
			primary: { usedPercent: 9, windowMinutes: 300, resetsAt: null },
			secondary: null,
		});
		expect(quotaFromMetadata({ codex: { quota: { limitName: 5 } } })).toBeNull();
		expect(quotaFromMetadata({ codex: {} })).toBeNull();
		expect(quotaFromMetadata({ openai: { quota: {} } })).toBeNull();
		expect(quotaFromMetadata(undefined)).toBeNull();
	});
});
