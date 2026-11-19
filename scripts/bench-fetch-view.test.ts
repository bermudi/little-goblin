// Tests for the bench viewer, asserting what a user can observe in the
// generated page: every provider, URL and outcome label lands in the
// static markup (the matrices render without JavaScript), the
// flakiness/coverage marks appear, and a malformed run record fails
// loud on read instead of feeding the viewer garbage.
//
// FICTION: the run records below are synthetic fixtures. No provider
// was called, no URL fetched; the numbers only exercise rendering.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BenchCell,
	type BenchRun,
	benchRunSchema,
	readRunRecords,
	writeRunRecord,
} from "./bench-fetch-record.ts";
import { buildHtml } from "./bench-fetch-view.ts";

const URLS = [
	"https://example.com/",
	"https://www.reuters.com/",
	"https://www.wsj.com/",
] as const;

// Row helper: one provider's cells across the three fixture URLs.
function row(...cells: BenchCell[]): BenchCell[] {
	return cells;
}

function c(
	outcome: BenchCell["outcome"],
	extra: Partial<BenchCell> = {},
): BenchCell {
	return { outcome, ...extra };
}

const PROVIDERS_DEFAULT = [
	{ kind: "local", hasLiveKnob: true },
	{ kind: "jina", authName: "jina", hasLiveKnob: true },
	{ kind: "tinyfish", candidate: true, hasLiveKnob: true },
	{
		kind: "tavily",
		authName: "tavily",
		skipped: 'no auth.jsonl record "tavily"',
		hasLiveKnob: false,
	},
];

// Default run 1: reuters is solo-jina; tinyfish flips on example.com in
// run 2; wsj has no winner in default mode.
const defaultRun1: BenchRun = benchRunSchema.parse({
	schema: 1,
	startedAt: "2026-11-19T10:00:00.000Z",
	mode: "default",
	urls: [...URLS],
	providers: PROVIDERS_DEFAULT,
	cells: [
		row(
			c("ok", {
				chars: 1250,
				status: 200,
				ms: 800,
				title: "Example Domain",
				textPreview:
					"Example Domain. This domain is for use in illustrative examples…",
			}),
			c("error", { ms: 300, note: "local: HTTP 401" }),
			c("blocked", {
				chars: 5600,
				status: 200,
				ms: 5100,
				title: "Just a moment...",
				textPreview: "Verifying you are human...",
			}),
		),
		row(
			c("ok", {
				chars: 900,
				status: 200,
				ms: 2400,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("ok", {
				chars: 41000,
				status: 200,
				ms: 6100,
				title: "Reuters",
				textPreview: "Reuters news article body… <div>markets</div>",
			}),
			c("thin", { ms: 1900, note: "jina: almost no text (140 chars)" }),
		),
		row(
			c("ok", {
				chars: 1100,
				status: 200,
				ms: 3200,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("blocked", {
				chars: 3200,
				status: 200,
				ms: 4400,
				note: "Just a moment...",
			}),
			c("error", {
				ms: 800,
				note: "tinyfish: extraction failed — bot_blocked",
			}),
		),
		row(
			c("skipped", { note: 'no auth.jsonl record "tavily"' }),
			c("skipped", { note: 'no auth.jsonl record "tavily"' }),
			c("skipped", { note: 'no auth.jsonl record "tavily"' }),
		),
	],
});

const defaultRun2: BenchRun = benchRunSchema.parse({
	...defaultRun1,
	startedAt: "2026-11-19T11:00:00.000Z",
	cells: [
		row(
			c("ok", {
				chars: 1250,
				status: 200,
				ms: 780,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("error", { ms: 290, note: "local: HTTP 401" }),
			c("blocked", {
				chars: 5600,
				status: 200,
				ms: 5300,
				title: "Just a moment...",
				textPreview: "Verifying you are human...",
			}),
		),
		row(
			c("ok", {
				chars: 900,
				status: 200,
				ms: 2300,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("ok", {
				chars: 42000,
				status: 200,
				ms: 5900,
				title: "Reuters",
				textPreview: "Reuters news article body…",
			}),
			c("thin", { ms: 2100, note: "jina: almost no text (140 chars)" }),
		),
		row(
			c("error", { ms: 1500, note: "tinyfish: extraction failed — timeout" }),
			c("blocked", {
				chars: 3100,
				status: 200,
				ms: 4500,
				note: "Just a moment...",
			}),
			c("rejected", { ms: 900, note: "tinyfish: no result" }),
		),
		row(
			c("skipped", { note: 'no auth.jsonl record "tavily"' }),
			c("skipped", { note: 'no auth.jsonl record "tavily"' }),
			c("skipped", { note: 'no auth.jsonl record "tavily"' }),
		),
	],
});

// Live run: tavily has no live knob → its cells carry maybeCached ("~").
const liveRun: BenchRun = benchRunSchema.parse({
	schema: 1,
	startedAt: "2026-11-19T12:00:00.000Z",
	mode: "live",
	urls: [...URLS],
	providers: PROVIDERS_DEFAULT,
	cells: [
		row(
			c("ok", {
				chars: 1250,
				status: 200,
				ms: 900,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("blocked", {
				chars: 5600,
				status: 200,
				ms: 5200,
				title: "Just a moment...",
				textPreview: "Verifying you are human...",
			}),
			c("pdf", { chars: 200000, status: 200, ms: 7300 }),
		),
		row(
			c("ok", {
				chars: 900,
				status: 200,
				ms: 2500,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("blocked", {
				chars: 3000,
				status: 200,
				ms: 6600,
				note: "no live knob — may be cached · Just a moment...",
			}),
			c("error", { ms: 1200, note: "jina: HTTP 429" }),
		),
		row(
			c("ok", {
				chars: 1100,
				status: 200,
				ms: 3400,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("ok", {
				chars: 41500,
				status: 200,
				ms: 5800,
				title: "Reuters",
				textPreview: "Reuters news article body…",
			}),
			c("blocked", {
				chars: 2900,
				status: 200,
				ms: 6100,
				note: "Just a moment...",
			}),
		),
		row(
			c("ok", {
				chars: 980,
				status: 200,
				ms: 2100,
				maybeCached: true,
				title: "Example Domain",
				textPreview: "Example Domain…",
			}),
			c("blocked", {
				chars: 4100,
				status: 200,
				ms: 4300,
				maybeCached: true,
				note: "no live knob — may be cached · Just a moment...",
			}),
			c("ok", {
				chars: 8800,
				status: 200,
				ms: 4900,
				maybeCached: true,
				note: "no live knob — may be cached · WSJ headline digest",
			}),
		),
	],
});

const html = buildHtml([defaultRun1, defaultRun2, liveRun]);

test("the page names every provider, URL and outcome in its static markup", () => {
	for (const kind of ["local", "jina", "tinyfish", "tavily"]) {
		expect(html).toContain(`data-kind="${kind}"`);
		expect(html).toContain(`<span class="pname">${kind}</span>`);
	}
	for (const url of URLS) {
		expect(html).toContain(`data-url="${url}"`);
		expect(html).toContain(shortLabel(url));
	}
	// Every outcome label rides on a matrix cell, not just the legend.
	for (const outcome of [
		"ok",
		"pdf",
		"blocked",
		"thin",
		"rejected",
		"error",
		"skipped",
	]) {
		expect(html).toContain(`data-outcome="${outcome}"`);
		expect(html).toContain(`<span class="chip c-${outcome}">${outcome}</span>`);
	}
});

test("the page marks flakiness, solo coverage and maybe-cached cells", () => {
	// tinyfish flipped on example.com (ok → error) and wsj (error → rejected).
	expect(html).toContain("flips 2");
	expect(html).toContain("1/2 <span");
	// reuters in default mode: jina is the only ever-winner.
	expect(html).toContain("solo: jina");
	// wsj in default mode: nobody ever succeeded → coverage "none".
	expect(html).toContain('<span class="chip c-none">none</span>');
	// tavily's live cells carry the maybe-cached tilde.
	expect(html).toContain('<span class="tilde"');
	expect(html).toContain('data-outcome="ok">ok<span class="tilde"');
	// the any-provider row exists in both mode sections.
	expect(html.match(/any provider/g)?.length).toBe(2);
});

test("both mode sections render with their switch and panels", () => {
	expect(html).toContain('id="r-default"');
	expect(html).toContain('id="r-live"');
	expect(html).toContain('id="sec-default"');
	expect(html).toContain('id="sec-live"');
	// the CSS toggle must target the section IDs that actually exist —
	// a class selector here leaves both sections visible (found live,
	// 2026-11-19: `.sec-live` matched nothing, `id="sec-live"` did).
	expect(html).toContain("#r-default:checked ~ main > #sec-live");
	expect(html).toContain("#r-live:checked ~ main > #sec-default");
	// latency rows carry sortable data, chain pickers their chips
	expect(html).toContain('data-med="');
	expect(html).toContain('class="chain-chip" data-kind="tinyfish"');
	// raw runs are embedded for the drill-down script, "<" escaped
	// so page text inside a preview cannot close the data tag early
	expect(html).toContain('id="runs-data"');
	expect(html).toContain("\\u003c");
	const blobStart = html.indexOf('id="runs-data">');
	const blobEnd = html.indexOf("</script>", blobStart);
	expect(html.slice(blobStart, blobEnd)).not.toContain("</");
});

test("JS probe results and URL tags render in the static page", () => {
	const run: BenchRun = benchRunSchema.parse({
		schema: 1,
		startedAt: "2026-11-19T13:00:00.000Z",
		mode: "default",
		urls: [URLS[0], "https://quotes.toscrape.com/js/"],
		jsProbes: [URLS[0], "https://quotes.toscrape.com/js/"],
		providers: [
			{ kind: "local", hasLiveKnob: true },
			{ kind: "tavily", hasLiveKnob: false },
		],
		cells: [
			[
				c("ok", { chars: 156, jsExec: false }),
				c("thin", { chars: 100, jsExec: false }),
			],
			[
				c("ok", { chars: 958, jsExec: true }),
				c("ok", { chars: 1700, jsExec: true }),
			],
		],
	});
	const jsHtml = buildHtml([run]);
	expect(jsHtml).toContain("+js");
	expect(jsHtml).toContain("−js");
	expect(jsHtml).toContain(">control</span>");
	expect(jsHtml).toContain(">JS probe</span>");
});

test("a run record round-trips through disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-bench-view-"));
	try {
		const path = writeRunRecord(defaultRun1, dir);
		expect(path).toStartWith(join(dir, "run-"));
		expect(readRunRecords(dir)).toEqual([defaultRun1]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed records fail loud with their path", () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-bench-view-"));
	try {
		writeFileSync(join(dir, "run-bad-json.json"), "{not json");
		expect(() => readRunRecords(dir)).toThrow(
			/run-bad-json\.json.*malformed JSON/s,
		);
		writeFileSync(
			join(dir, "run-bad-shape.json"),
			JSON.stringify({ schema: 1 }),
		);
		expect(() => readRunRecords(dir)).toThrow(/run-bad-shape\.json/s);
		// unrelated files are ignored, missing dir is empty history
		writeFileSync(join(dir, "notes.txt"), "x");
		rmSync(join(dir, "run-bad-json.json"));
		rmSync(join(dir, "run-bad-shape.json"));
		expect(readRunRecords(dir)).toEqual([]);
		expect(readRunRecords(join(dir, "nope"))).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function shortLabel(url: string): string {
	const u = new URL(url);
	const path = u.pathname === "/" ? "" : u.pathname;
	return `${u.hostname.replace(/^www\./, "")}${path}`;
}
