import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { Age, ageLabel, messageCreatedAt } from "./messageAge.tsx";
import { MetaLine, turnMeta } from "./MetaLine.tsx";
import type { TurnMetadata } from "../../../src/http/app-wire.ts";
import { createElement } from "react";

// A fixed local "now" the whole file reasons against — Date components
// stay local so the expectations hold in any timezone the suite runs in.
const NOW = new Date(2026, 10, 16, 18, 45, 30).getTime(); // Mon Nov 16 2026, 18:45:30
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("ageLabel", () => {
	test("under a minute is just now — including a future stamp", () => {
		expect(ageLabel(ago(12_000), NOW)).toBe("just now");
		expect(ageLabel(new Date(NOW + 5_000).toISOString(), NOW)).toBe("just now");
	});

	test("under an hour is N minutes ago, singular at one", () => {
		expect(ageLabel(ago(60_000), NOW)).toBe("1 minute ago");
		expect(ageLabel(ago(3 * 60_000), NOW)).toBe("3 minutes ago");
		expect(ageLabel(ago(59 * 60_000), NOW)).toBe("59 minutes ago");
	});

	test("same-day older than an hour is the clock time", () => {
		expect(ageLabel(ago(3 * 3_600_000), NOW)).toBe("15:45");
		expect(ageLabel(new Date(2026, 10, 16, 7, 5).toISOString(), NOW)).toBe("07:05");
	});

	test("past a day adds the date; another year adds the year", () => {
		const at = new Date(2026, 10, 14, 17, 39).toISOString();
		const day = new Date(2026, 10, 14).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
		expect(ageLabel(at, NOW)).toBe(`${day}, 17:39`);

		const old = new Date(2024, 0, 2, 9, 4).toISOString();
		const oldDay = new Date(2024, 0, 2).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
		expect(ageLabel(old, NOW)).toBe(`${oldDay}, 09:04`);
	});

	test("an unparseable stamp renders nothing", () => {
		expect(ageLabel("not-a-date", NOW)).toBe("");
	});
});

describe("messageCreatedAt", () => {
	const m = (metadata: unknown) => ({ id: "m", role: "assistant", parts: [], metadata }) as UIMessage;

	test("reads the stamp, narrows everything else away", () => {
		expect(messageCreatedAt(m({ createdAt: "2026-11-16T18:00:00Z" }))).toBe(
			"2026-11-16T18:00:00Z",
		);
		expect(messageCreatedAt(m(undefined))).toBeNull();
		expect(messageCreatedAt(m("blob"))).toBeNull();
		expect(messageCreatedAt(m({ createdAt: 42 }))).toBeNull();
	});
});

describe("MetaLine age", () => {
	const meta: TurnMetadata = {
		model: "prov/m",
		finishReason: "stop",
		durationMs: 1000,
		createdAt: ago(3 * 60_000),
		forcedCompletion: null,
		usage: {
			input: 10,
			output: 5,
			cacheRead: null,
			cacheWrite: null,
			lastInput: 10,
			lastCacheRead: null,
		},
	};

	test("the line ends on the age as a <time> element", () => {
		const html = renderToStaticMarkup(createElement(MetaLine, { meta, now: NOW }));
		expect(html).toContain("<time");
		expect(html).toContain(`dateTime="${meta.createdAt}"`);
		expect(html).toContain("3 minutes ago");
		expect(html).toContain("prov/m · 1.0s");
	});

	test("no stamp, no age — pre-stamp history stays as before", () => {
		const { createdAt: _drop, ...rest } = meta;
		const html = renderToStaticMarkup(createElement(MetaLine, { meta: rest, now: NOW }));
		expect(html).not.toContain("<time");
	});

	test("an invalid stamp still mounts the element, blank", () => {
		const html = renderToStaticMarkup(
			createElement(Age, { at: "junk", now: NOW }),
		);
		expect(html).toContain('dateTime="junk"');
		expect(html).not.toContain("ago");
	});
});

describe("turnMeta", () => {
	const base = {
		model: "prov/m",
		finishReason: "stop",
		durationMs: 5,
		usage: {},
	};

	test("carries the served createdAt, absent when unstamped", () => {
		const stamped = turnMeta({
			id: "a",
			role: "assistant",
			parts: [],
			metadata: { ...base, createdAt: "2026-11-16T18:00:00Z" },
		} as UIMessage);
		expect(stamped?.createdAt).toBe("2026-11-16T18:00:00Z");

		const legacy = turnMeta({
			id: "a",
			role: "assistant",
			parts: [],
			metadata: base,
		} as UIMessage);
		expect(legacy).not.toBeNull();
		expect(legacy?.createdAt).toBeUndefined();
	});
});
