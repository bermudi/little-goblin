// Viewer for the fetch-provider benchmark: reads every run record in
// bench-records/ and emits ONE self-contained static HTML file — inline
// CSS, JS and data, no server, no build, no CDN — openable by
// double-click. A dev tool: deliberately outside app/ and src/http,
// which are goblin's product client and its server.
//
//   bun scripts/bench-fetch-view.ts [--out=<path>]
//
// What the operator reads here, in priority order (brief, #756):
// matrix (colour + label, never colour alone), default/live switch,
// flakiness over repeated runs, cell + URL drill-downs with extract
// previews, any-provider coverage with solo marks, latency table, and
// an ordered chain picker with a median-based worst-case estimate.
//
// The two mode sections are rendered statically in the generator and
// toggled by a pure-CSS radio switch, so the matrices read without
// JavaScript; the inline script only powers drill-downs, latency
// sorting and the chain picker. Malformed records fail loud at read
// time (bench-fetch-record.ts), never as a half-rendered page.

import { parseArgs } from "node:util";
import { durableWriteFile } from "../src/durable.ts";
import {
	type BenchCell,
	type BenchRun,
	readRunRecords,
	recordsDir,
} from "./bench-fetch-record.ts";

// ---------- aggregation ----------

type Mode = "default" | "live";

interface CellEntry {
	run: BenchRun;
	cell: BenchCell;
}

interface ProviderAgg {
	kind: string;
	candidate: boolean;
	via: string;
	authName: string | undefined;
	skipReasons: string[];
	hasLiveKnob: boolean;
}

interface ModeModel {
	mode: Mode;
	runs: BenchRun[];
	providers: ProviderAgg[];
	urls: string[];
	cells: Map<string, Map<string, CellEntry[]>>;
}

function aggregate(runs: BenchRun[], mode: Mode): ModeModel {
	const inMode = runs.filter((r) => r.mode === mode);
	const providers: ProviderAgg[] = [];
	const urls: string[] = [];
	const cells = new Map<string, Map<string, CellEntry[]>>();
	for (const run of inMode) {
		for (const p of run.providers) {
			let agg = providers.find((x) => x.kind === p.kind);
			if (!agg) {
				agg = {
					kind: p.kind,
					candidate: p.candidate === true,
					via: p.via ?? "",
					authName: p.authName,
					skipReasons: [],
					hasLiveKnob: p.hasLiveKnob,
				};
				providers.push(agg);
			}
			if (!agg.via && p.via) agg.via = p.via;
			if (p.skipped && !agg.skipReasons.includes(p.skipped))
				agg.skipReasons.push(p.skipped);
		}
		for (const url of run.urls) if (!urls.includes(url)) urls.push(url);
		run.providers.forEach((p, i) => {
			const row = run.cells[i] ?? [];
			run.urls.forEach((url, j) => {
				const cell = row[j];
				if (!cell) return;
				let byUrl = cells.get(p.kind);
				if (!byUrl) {
					byUrl = new Map();
					cells.set(p.kind, byUrl);
				}
				let list = byUrl.get(url);
				if (!list) {
					list = [];
					byUrl.set(url, list);
				}
				list.push({ run, cell });
			});
		});
	}
	return { mode, runs: inMode, providers, urls, cells };
}

function entriesFor(model: ModeModel, kind: string, url: string): CellEntry[] {
	return model.cells.get(kind)?.get(url) ?? [];
}

function isSuccess(cell: BenchCell): boolean {
	return cell.outcome === "ok" || cell.outcome === "pdf";
}

// ---------- formatting ----------

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		c === "&"
			? "&amp;"
			: c === "<"
				? "&lt;"
				: c === ">"
					? "&gt;"
					: c === '"'
						? "&quot;"
						: "&#39;",
	);
}

// JSON inside a <script type="application/json">: only "</" can end the
// tag early; escape every "<" so arbitrary page text cannot break out.
function jsonForScript(data: unknown): string {
	return JSON.stringify(data).replace(/</g, "\\u003c");
}

function fmtChars(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function fmtMs(ms: number | undefined): string {
	if (ms === undefined) return "—";
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${ms}ms`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
});

function fmtDate(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

function shortUrl(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname === "/" ? "" : u.pathname;
		return `${u.hostname.replace(/^www\./, "")}${path}`;
	} catch {
		return url;
	}
}

function median(xs: number[]): number | undefined {
	if (xs.length === 0) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function p95(xs: number[]): number | undefined {
	if (xs.length === 0) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	// Nearest-rank: ceil(0.95 n), clamped into range.
	const i = Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * 0.95) - 1));
	return s[i];
}

function outcomeClass(outcome: BenchCell["outcome"]): string {
	return `c-${outcome}`;
}

function chipHtml(cell: BenchCell, opts?: { tilde?: boolean }): string {
	const label = cell.outcome === "pdf" ? "pdf" : cell.outcome;
	const tilde =
		(opts?.tilde ?? true) && cell.maybeCached
			? `<span class="tilde" title="no live knob on this provider — may be a cache hit">~</span>`
			: "";
	return `<span class="chip ${outcomeClass(cell.outcome)}" data-outcome="${cell.outcome}">${label}${tilde}</span>`;
}

function stripHtml(entries: CellEntry[]): string {
	const dots = entries
		.map((e) => {
			const meta = [
				`${fmtDate(e.run.startedAt)} (${e.run.mode})`,
				e.cell.outcome,
				e.cell.chars !== undefined ? ` ${fmtChars(e.cell.chars)}` : "",
				e.cell.maybeCached ? " ~" : "",
			].join("");
			return `<i class="${outcomeClass(e.cell.outcome)}${e.cell.maybeCached ? " mc" : ""}" title="${esc(meta)}"></i>`;
		})
		.join("");
	return `<span class="strip" aria-hidden="true">${dots}</span>`;
}

// ---------- matrix ----------

function matrixHtml(model: ModeModel): string {
	const kRuns = model.runs.length;
	const head = model.urls
		.map((url) => {
			const winners = model.providers.filter((p) =>
				entriesFor(model, p.kind, url).some((e) => isSuccess(e.cell)),
			);
			const solo =
				winners.length === 1
					? `<span class="solo" title="exactly one provider ever succeeded on this url in this mode">solo: ${esc(winners[0]!.kind)}</span>`
					: "";
			return `<th class="urlh" scope="col" role="button" tabindex="0" aria-haspopup="dialog" data-url="${esc(url)}" data-mode="${model.mode}" title="${esc(url)}"><span class="ulabel">${esc(shortUrl(url))}</span>${solo}</th>`;
		})
		.join("");

	const rows = model.providers
		.map((p) => {
			const skipTitle = p.skipReasons.join("; ");
			const viaTitle = [
				p.via,
				p.hasLiveKnob ? "has live knob" : "no live knob",
				skipTitle ? `skipped: ${skipTitle}` : "",
			]
				.filter(Boolean)
				.join(" · ");
			const tag = p.candidate ? `<span class="ptag">candidate</span>` : "";

			// Flips: urls whose non-skipped outcomes differ across runs.
			const flips = model.urls.filter((url) => {
				const outcomes = new Set(
					entriesFor(model, p.kind, url)
						.filter((e) => e.cell.outcome !== "skipped")
						.map((e) => e.cell.outcome),
				);
				return outcomes.size > 1;
			});
			const flipBadge = flips.length
				? `<span class="flips" title="outcome changed across runs on: ${esc(flips.map(shortUrl).join(", "))}">flips ${flips.length}</span>`
				: "";

			const cells = model.urls
				.map((url) => matrixCellHtml(model, p, url, kRuns))
				.join("");

			// Score: the provider's own latest run, plus the run-average.
			const provRuns = model.runs.filter((r) =>
				r.providers.some((x) => x.kind === p.kind),
			);
			const latest = provRuns[provRuns.length - 1];
			let scoreHtml = "—";
			if (latest) {
				const i = latest.providers.findIndex((x) => x.kind === p.kind);
				const row = latest.cells[i] ?? [];
				const ok = row.filter(isSuccess).length;
				const avg =
					provRuns.length > 1
						? ` <span class="sub">avg ${(
								provRuns.reduce((acc, r) => {
									const idx = r.providers.findIndex((x) => x.kind === p.kind);
									return acc + (r.cells[idx] ?? []).filter(isSuccess).length;
								}, 0) / provRuns.length
							).toFixed(1)}/${row.length}</span>`
						: "";
				scoreHtml = `<span class="big">${ok}/${row.length}</span>${avg}`;
			}
			return `<tr><th scope="row" class="prov" title="${esc(viaTitle)}"><span class="pname">${esc(p.kind)}</span>${tag}${flipBadge}</th>${cells}<td class="score">${scoreHtml}</td></tr>`;
		})
		.join("");

	const cover = model.urls
		.map((url) => {
			const winners = model.providers.filter((p) =>
				entriesFor(model, p.kind, url).some((e) => isSuccess(e.cell)),
			);
			if (winners.length === 0) {
				return `<td class="cell cover"><span class="chip c-none">none</span></td>`;
			}
			const runRate =
				kRuns > 1
					? (() => {
							const covered = model.runs.filter((r) => {
								const idxByUrl = new Map(r.urls.map((u, j) => [u, j] as const));
								const j = idxByUrl.get(url);
								if (j === undefined) return false;
								return r.cells.some((row) => isSuccess(row[j] ?? { outcome: "skipped" }));
							}).length;
							return ` <span class="sub">${covered}/${kRuns} runs</span>`;
						})()
					: "";
			return `<td class="cell cover"><span class="chip c-ok">ok</span>${runRate}</td>`;
		})
		.join("");

	return `<div class="matrix-wrap"><table class="matrix">
<thead><tr><th class="corner">provider</th>${head}<th class="scoreh">score</th></tr></thead>
<tbody>${rows}<tr><th scope="row" class="prov anyprov"><span class="pname">any provider</span></th>${cover}<td class="score"></td></tr></tbody>
</table></div>`;
}

function matrixCellHtml(
	model: ModeModel,
	p: ProviderAgg,
	url: string,
	kRuns: number,
): string {
	const entries = entriesFor(model, p.kind, url);
	if (entries.length === 0) {
		return `<td class="cell absent" title="no run of this mode put ${esc(p.kind)} against this url">—</td>`;
	}
	const latest = entries[entries.length - 1]!.cell;
	const chip = chipHtml(latest);
	const meta =
		latest.outcome === "skipped"
			? `<span class="meta skipnote">${esc(p.skipReasons[0] ?? "skipped")}</span>`
			: `<span class="meta">${latest.chars !== undefined ? (latest.outcome === "pdf" ? `${fmtChars(latest.chars)}B` : fmtChars(latest.chars)) : ""}${latest.chars !== undefined && latest.ms !== undefined ? " · " : ""}${fmtMs(latest.ms)}</span>`;
	const counted = entries.filter((e) => e.cell.outcome !== "skipped");
	const rate =
		counted.length > 1
			? `<span class="rate">${counted.filter((e) => isSuccess(e.cell)).length}/${counted.length} ${stripHtml(entries)}</span>`
			: "";
	return `<td class="cell" role="button" tabindex="0" aria-haspopup="dialog" data-kind="${esc(p.kind)}" data-url="${esc(url)}" data-mode="${model.mode}">${chip}${meta}${rate}</td>`;
}

// ---------- latency ----------

function latencyHtml(model: ModeModel): string {
	const rows = model.providers
		.map((p) => {
			const xs: number[] = [];
			for (const url of model.urls)
				for (const e of entriesFor(model, p.kind, url))
					if (e.cell.outcome !== "skipped" && e.cell.ms !== undefined)
						xs.push(e.cell.ms);
			return { p, n: xs.length, med: median(xs), hi: p95(xs) };
		})
		.filter((r) => r.n > 0)
		.sort((a, b) => (a.med ?? 0) - (b.med ?? 0));
	const body = rows
		.map(
			(r) => `<tr data-kind="${esc(r.p.kind)}" data-n="${r.n}" data-med="${r.med ?? 0}" data-p95="${r.hi ?? 0}">
<td class="pname">${esc(r.p.kind)}${r.p.candidate ? `<span class="ptag">candidate</span>` : ""}</td>
<td class="num">${r.n}</td>
<td class="num">${fmtMs(r.med)}</td>
<td class="num">${fmtMs(r.hi)}</td>
</tr>`,
		)
		.join("");
	return `<table class="latency">
<thead><tr><th data-key="kind" data-type="str">provider</th><th data-key="n" data-type="num" title="cells with a timing (skipped excluded)">cells</th><th data-key="med" data-type="num" aria-sort="ascending">median</th><th data-key="p95" data-type="num">p95</th></tr></thead>
<tbody>${body}</tbody>
</table>`;
}

// ---------- chain ----------

// The static shell; the inline script computes coverage from the
// embedded runs (chain order is operator interaction, not build-time).
function chainHtml(model: ModeModel): string {
	if (model.runs.length === 0) return "";
	const chips = model.providers
		.map(
			(p) =>
				`<button type="button" class="chain-chip" data-kind="${esc(p.kind)}">${esc(p.kind)}</button>`,
		)
		.join("");
	return `<div class="chain-card" data-mode="${model.mode}">
<h3>chain <span class="sub">pick providers in order — first success wins; latency is a median-based estimate</span></h3>
<div class="chain-pick">${chips}</div>
<ol class="chain-order"></ol>
<div class="chain-result"></div>
</div>`;
}

// ---------- sections ----------

function sectionHtml(model: ModeModel): string {
	if (model.runs.length === 0) {
		return `<section class="sec" id="sec-${model.mode}"><h2>${model.mode} <span class="sub">no runs yet</span></h2></section>`;
	}
	const latest = model.runs[model.runs.length - 1]!;
	return `<section class="sec" id="sec-${model.mode}">
<h2>${model.mode} <span class="sub">${model.runs.length} run${model.runs.length > 1 ? "s" : ""} · latest ${fmtDate(latest.startedAt)} · ${model.mode === "live" ? "no-cache knobs forced" : "provider cache accepted"}</span></h2>
${matrixHtml(model)}
<div class="under">
<div class="latency-card"><h3>latency <span class="sub">click a column to sort</span></h3>${latencyHtml(model)}</div>
${chainHtml(model)}
</div>
</section>`;
}

// ---------- header ----------

function headerHtml(runs: BenchRun[], models: Record<Mode, ModeModel>): string {
	const total = runs.length;
	const last = runs[runs.length - 1];
	const kinds = new Map<string, { candidate: boolean; via: string; skip: string }>();
	for (const run of runs)
		for (const p of run.providers) {
			const prev = kinds.get(p.kind);
			kinds.set(p.kind, {
				candidate: (prev?.candidate ?? false) || p.candidate === true,
				via: prev?.via || p.via || "",
				skip: prev?.skip || p.skipped || "",
			});
		}
	const chips = [...kinds.entries()]
		.map(
			([kind, k]) =>
				`<span class="pchip${k.skip ? " skipped" : ""}" title="${esc([k.via, k.skip ? `skipped: ${k.skip}` : ""].filter(Boolean).join(" · "))}">${esc(kind)}${k.candidate ? "⁕" : ""}${k.skip ? ` — ${esc(k.skip)}` : ""}</span>`,
		)
		.join("");
	const nD = models.default.runs.length;
	const nL = models.live.runs.length;
	const meta = [
		`${total} run${total === 1 ? "" : "s"}`,
		`default ${nD}`,
		`live ${nL}`,
		last ? `latest ${fmtDate(last.startedAt)}` : "",
	].filter(Boolean);
	return `<header>
<h1>fetch-provider benchmark</h1>
<p class="meta">${meta.join(" · ")}</p>
<div class="prow"><span class="plabel">keyed / skipped:</span> ${chips || "<span class=\"plabel\">no providers</span>"}</div>
<p class="legend">
<span class="chip c-ok">ok</span><span class="chip c-pdf">pdf</span><span class="chip c-blocked">blocked</span><span class="chip c-thin">thin</span><span class="chip c-rejected">rejected</span><span class="chip c-error">error</span><span class="chip c-skipped">skipped</span>
<span class="legnote"><span class="tilde">~</span> may be cached (no live knob)</span>
<span class="legnote">squares under a cell = older→newer runs</span>
<span class="legnote">⁕ candidate</span>
</p>
</header>`;
}

// ---------- page ----------

export function buildHtml(runs: BenchRun[]): string {
	const models: Record<Mode, ModeModel> = {
		default: aggregate(runs, "default"),
		live: aggregate(runs, "live"),
	};
	const defActive = models.default.runs.length > 0;
	const liveActive = models.live.runs.length > 0;
	const modeBar = `<div class="modebar">
<label for="r-default">default <span class="n">${models.default.runs.length}</span></label>
<label for="r-live">live <span class="n">${models.live.runs.length}</span></label>
</div>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fetch-provider benchmark</title>
<style>
${css}
</style>
</head>
<body>
<input type="radio" name="mode" id="r-default" class="mode-radio"${defActive ? " checked" : ""}${defActive ? "" : " disabled"}>
<input type="radio" name="mode" id="r-live" class="mode-radio"${defActive ? "" : " checked"}${liveActive ? "" : " disabled"}>
${headerHtml(runs, models)}
${modeBar}
<main>
${sectionHtml(models.default)}
${sectionHtml(models.live)}
</main>
<footer>generated by <code>scripts/bench-fetch-view.ts</code> from ${runs.length} run record${runs.length === 1 ? "" : "s"} · local data, never committed</footer>
<dialog id="cell-dialog" aria-label="cell detail"></dialog>
<dialog id="url-dialog" aria-label="url detail"></dialog>
<script type="application/json" id="runs-data">${jsonForScript(runs)}</script>
<script>
${pageJs}
</script>
</body>
</html>
`;
}

// ---------- CSS ----------
//
// Identity: an engineering results sheet — serif for headings and
// prose, mono for every number and label; the outcome palette is the
// only colour on an otherwise neutral page, so the matrix reads as the
// hero. Light/dark through prefers-color-scheme; every colour pairs
// with a text label, never colour alone.

const css = `
:root {
	--serif: "Iowan Old Style", "Palatino Linotype", Palatino, Charter, Georgia, serif;
	--mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;
	--bg: #f5f5f1; --surface: #fdfdfb; --ink: #1d1f24; --muted: #5d6470;
	--line: #dcdcd3; --accent: #2f4fd8; --on-accent: #fff;
	--c-ok: #147a3c; --c-pdf: #1f5fd0; --c-blocked: #c22f26; --c-thin: #94700e;
	--c-rejected: #bc4a09; --c-error: #7a3bd6; --c-skipped: #6b7078; --c-none: #6b7078;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131418; --surface: #1b1d23; --ink: #e8e8e3; --muted: #9a9fa8;
		--line: #2c2f37; --accent: #8ba0ff; --on-accent: #101223;
		--c-ok: #58c47c; --c-pdf: #74aaff; --c-blocked: #ff7b71; --c-thin: #e0b341;
		--c-rejected: #ff9a5c; --c-error: #b18cff; --c-skipped: #8b8f98; --c-none: #8b8f98;
	}
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
	margin: 0 auto; padding: 20px 20px 48px; max-width: 1100px;
	font-family: var(--mono); font-size: 13px; line-height: 1.5;
	color: var(--ink); background: var(--bg);
}
h1, h2, h3, .hint { font-family: var(--serif); }
h1 { font-size: 27px; line-height: 1.15; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 19px; margin: 26px 0 10px; }
h2 .sub, h3 .sub { font-family: var(--mono); font-size: 11.5px; color: var(--muted); font-weight: 400; margin-left: 8px; }
h3 { font-size: 15px; margin: 0 0 8px; }
.meta { color: var(--muted); margin: 0 0 10px; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 12px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

.mode-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.modebar { display: flex; gap: 8px; margin: 6px 0 2px; }
.modebar label {
	font-family: var(--mono); font-size: 12.5px; padding: 5px 14px; cursor: pointer;
	border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: var(--surface);
}
.modebar label .n { color: var(--muted); opacity: .8; }
.modebar label:hover { border-color: var(--accent); color: var(--ink); }
#r-default:checked ~ .modebar label[for="r-default"],
#r-live:checked ~ .modebar label[for="r-live"] {
	background: var(--accent); color: var(--on-accent); border-color: var(--accent);
}
#r-default:checked ~ .modebar label[for="r-default"] .n,
#r-live:checked ~ .modebar label[for="r-live"] .n { color: var(--on-accent); }
#r-default:disabled ~ .modebar label[for="r-default"],
#r-live:disabled ~ .modebar label[for="r-live"] { opacity: .45; cursor: not-allowed; }
#r-default:focus-visible ~ .modebar label[for="r-default"],
#r-live:focus-visible ~ .modebar label[for="r-live"] { outline: 2px solid var(--accent); outline-offset: 2px; }
#r-default:checked ~ main > #sec-live, #r-live:checked ~ main > #sec-default { display: none; }

.prow { margin: 4px 0 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.plabel { color: var(--muted); font-size: 11.5px; }
.pchip {
	font-size: 11.5px; border: 1px solid var(--line); border-radius: 4px; padding: 1px 7px;
	background: var(--surface); max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pchip.skipped { border-style: dashed; color: var(--muted); white-space: normal; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin: 10px 0 0; }
.legend .chip { font-size: 10.5px; padding: 0 6px; }
.legnote { color: var(--muted); font-size: 11.5px; }

.chip {
	display: inline-block; font-size: 11.5px; padding: 0 7px; border-radius: 4px;
	border: 1px solid; line-height: 1.7; font-weight: 600; vertical-align: baseline;
}
.c-ok     { color: var(--c-ok); border-color: color-mix(in srgb, var(--c-ok) 45%, transparent); background: color-mix(in srgb, var(--c-ok) 12%, transparent); }
.c-pdf    { color: var(--c-pdf); border-color: color-mix(in srgb, var(--c-pdf) 45%, transparent); background: color-mix(in srgb, var(--c-pdf) 12%, transparent); }
.c-blocked{ color: var(--c-blocked); border-color: color-mix(in srgb, var(--c-blocked) 45%, transparent); background: color-mix(in srgb, var(--c-blocked) 12%, transparent); }
.c-thin   { color: var(--c-thin); border-color: color-mix(in srgb, var(--c-thin) 45%, transparent); background: color-mix(in srgb, var(--c-thin) 12%, transparent); }
.c-rejected{ color: var(--c-rejected); border-color: color-mix(in srgb, var(--c-rejected) 45%, transparent); background: color-mix(in srgb, var(--c-rejected) 12%, transparent); }
.c-error  { color: var(--c-error); border-color: color-mix(in srgb, var(--c-error) 45%, transparent); background: color-mix(in srgb, var(--c-error) 12%, transparent); }
.c-skipped{ color: var(--c-skipped); border-color: color-mix(in srgb, var(--c-skipped) 45%, transparent); background: color-mix(in srgb, var(--c-skipped) 8%, transparent); }
.c-none   { color: var(--c-none); border-color: color-mix(in srgb, var(--c-none) 45%, transparent); background: transparent; }
.tilde { margin-left: 3px; font-weight: 700; }

.matrix-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
table.matrix { border-collapse: separate; border-spacing: 0; font-size: 12px; }
.matrix th, .matrix td { padding: 7px 9px; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); vertical-align: top; }
.matrix thead th { position: sticky; top: 0; background: var(--surface); z-index: 2; text-align: left; }
.matrix .corner, .matrix .prov { position: sticky; left: 0; background: var(--surface); z-index: 1; text-align: left; }
.matrix thead .corner { z-index: 3; }
.matrix tbody tr:last-child th, .matrix tbody tr:last-child td { border-bottom: none; }
.matrix td.cell { min-width: 96px; cursor: pointer; }
.matrix td.cell:hover, .matrix td.cell:focus-visible { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.matrix td.cell.cover { cursor: default; }
.matrix td.cell.cover:hover, .matrix td.cell.cover:focus-visible { background: transparent; }
.matrix td.cell.absent { color: var(--muted); text-align: center; cursor: default; }
.matrix .urlh { cursor: pointer; min-width: 96px; font-weight: 600; font-size: 11.5px; }
.matrix .urlh:hover, .matrix .urlh:focus-visible { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.matrix .ulabel { display: inline-block; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.matrix .solo { display: block; font-size: 10px; font-weight: 400; color: var(--c-blocked); }
.matrix .prov { font-weight: 600; font-size: 12.5px; }
.matrix .pname { display: block; }
.matrix .ptag { display: block; font-size: 10px; font-weight: 400; color: var(--muted); }
.matrix .flips { display: block; font-size: 10px; color: var(--c-thin); }
.matrix .meta { display: block; color: var(--muted); font-size: 11px; white-space: nowrap; }
.matrix .skipnote { white-space: normal; max-width: 150px; }
.matrix .rate { display: flex; align-items: center; gap: 5px; font-size: 11px; margin-top: 2px; }
.matrix .anyprov .pname { color: var(--muted); font-weight: 400; font-style: italic; }
.matrix .score, .matrix .scoreh { text-align: right; }
.matrix .score .big { font-weight: 700; }
.matrix .sub { color: var(--muted); font-weight: 400; }
.strip { display: inline-flex; gap: 2px; }
.strip i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; border: 1px solid transparent; }
.strip i.c-ok { background: var(--c-ok); } .strip i.c-pdf { background: var(--c-pdf); }
.strip i.c-blocked { background: var(--c-blocked); } .strip i.c-thin { background: var(--c-thin); }
.strip i.c-rejected { background: var(--c-rejected); } .strip i.c-error { background: var(--c-error); }
.strip i.c-skipped { background: transparent; border-color: var(--c-skipped); }
.strip i.mc { opacity: .55; }

.under { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
.latency-card, .chain-card { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 12px 14px; min-width: 0; }
table.latency { border-collapse: collapse; width: 100%; font-size: 12px; }
.latency th { text-align: left; color: var(--muted); font-weight: 600; font-size: 11.5px; border-bottom: 1px solid var(--line); padding: 4px 8px 6px 0; cursor: pointer; user-select: none; white-space: nowrap; }
.latency th:hover { color: var(--ink); }
.latency td { padding: 4px 8px 4px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.latency .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.latency tr:last-child td { border-bottom: none; }

.chain-pick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chain-chip {
	font-family: var(--mono); font-size: 11.5px; padding: 2px 10px; cursor: pointer;
	border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink);
}
.chain-chip:hover { border-color: var(--accent); color: var(--accent); }
.chain-order { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0 0 8px; padding: 0; }
.chain-order li { display: inline-flex; align-items: center; gap: 5px; }
.chain-order .ord { color: var(--muted); font-size: 10.5px; }
.chain-order button {
	font-family: var(--mono); font-size: 11.5px; padding: 2px 10px; cursor: pointer;
	border: 1px solid var(--accent); border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--ink);
}
.chain-result table { border-collapse: collapse; width: 100%; font-size: 12px; }
.chain-result td, .chain-result th { padding: 3px 8px 3px 0; text-align: left; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.chain-result .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chain-result .miss { color: var(--c-blocked); font-weight: 600; }
.chain-result .total { font-weight: 700; }

dialog {
	border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink);
	max-width: min(860px, 94vw); width: min(860px, 94vw); max-height: 84vh; padding: 0;
	font-family: var(--mono); font-size: 12.5px;
}
dialog::backdrop { background: color-mix(in srgb, #000 55%, transparent); }
.dlg-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 14px 18px 10px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--surface); }
.dlg-head h3 { margin: 0; font-family: var(--serif); font-size: 16px; overflow-wrap: anywhere; }
.dlg-body { padding: 12px 18px 18px; overflow-y: auto; }
.dlg-close { font-family: var(--mono); font-size: 12px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.dlg-close:hover { color: var(--ink); border-color: var(--accent); }
.runblock { border-top: 1px dashed var(--line); padding: 10px 0 12px; }
.runblock:first-child { border-top: none; }
.runmeta { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin-bottom: 6px; }
.runmeta .when { color: var(--muted); font-size: 11.5px; }
.facts { display: flex; flex-wrap: wrap; gap: 4px 18px; color: var(--muted); font-size: 11.5px; margin: 4px 0; }
.pagetitle { font-family: var(--serif); font-size: 14px; margin: 6px 0 2px; }
.note, .errtext { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 0; }
.errtext { color: var(--c-blocked); }
.extract {
	white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; padding: 8px 10px;
	border-left: 3px solid var(--line); color: var(--ink); font-size: 12px; max-height: 220px; overflow-y: auto;
}
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.card .runmeta { margin-bottom: 2px; }

footer { margin-top: 34px; color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--line); padding-top: 12px; }

@media (max-width: 760px) {
	body { padding: 14px 12px 40px; }
	h1 { font-size: 22px; }
	.under { grid-template-columns: 1fr; }
	.matrix .prov { max-width: 110px; }
	.matrix .ulabel { max-width: 110px; }
	.matrix .scoreh, .matrix .score { font-size: 11px; }
	.cards { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
	* { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`;

// ---------- inline JS ----------
//
// No backticks and no \${} here on purpose: this whole constant lives
// inside a template literal. Quotes and + concatenation only.

const pageJs = `"use strict";
(function () {
	var runs = JSON.parse(document.getElementById("runs-data").textContent);
	var cellDialog = document.getElementById("cell-dialog");
	var urlDialog = document.getElementById("url-dialog");

	function esc(s) {
		return String(s).replace(/[&<>"']/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
		});
	}
	function fmtChars(n) {
		if (n === undefined || n === null) return "—";
		if (n >= 1000) return (n / 1000).toFixed(1) + "k";
		return String(n);
	}
	function fmtMs(ms) {
		if (ms === undefined || ms === null) return "—";
		if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
		return ms + "ms";
	}
	var dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
	function fmtDate(iso) {
		var d = new Date(iso);
		return isNaN(d.getTime()) ? iso : dateFmt.format(d);
	}
	function shortUrl(url) {
		try {
			var u = new URL(url);
			var path = u.pathname === "/" ? "" : u.pathname;
			return u.hostname.replace(/^www\\./, "") + path;
		} catch (e) { return url; }
	}
	function median(xs) {
		if (!xs.length) return undefined;
		var s = xs.slice().sort(function (a, b) { return a - b; });
		var mid = Math.floor(s.length / 2);
		return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
	}
	function isSuccess(c) { return c.outcome === "ok" || c.outcome === "pdf"; }
	function chipHtml(c) {
		var tilde = c.maybeCached
			? '<span class="tilde" title="no live knob — may be a cache hit">~</span>' : "";
		return '<span class="chip c-' + c.outcome + '">' + c.outcome + tilde + "</span>";
	}
	function stripHtml(entries) {
		return entries.map(function (e) {
			var t = fmtDate(e.run.startedAt) + " " + e.cell.outcome +
				(e.cell.chars !== undefined ? " " + fmtChars(e.cell.chars) : "") +
				(e.cell.maybeCached ? " ~" : "");
			return '<i class="c-' + e.cell.outcome + (e.cell.maybeCached ? " mc" : "") + '" title="' + esc(t) + '"></i>';
		}).join("");
	}
	// runs of one mode, cells of one provider×url, oldest first
	function entriesFor(mode, kind, url) {
		var out = [];
		runs.forEach(function (run) {
			if (run.mode !== mode) return;
			run.providers.forEach(function (p, i) {
				if (p.kind !== kind) return;
				var j = run.urls.indexOf(url);
				if (j === -1) return;
				var cell = (run.cells[i] || [])[j];
				if (cell) out.push({ run: run, cell: cell });
			});
		});
		return out;
	}

	function cellFacts(c) {
		var parts = [];
		if (c.status !== undefined) parts.push("status " + c.status);
		if (c.ms !== undefined) parts.push(fmtMs(c.ms));
		if (c.chars !== undefined) parts.push((c.outcome === "pdf" ? fmtChars(c.chars) + " bytes" : fmtChars(c.chars) + " chars"));
		return parts.length ? '<div class="facts">' + parts.map(esc).join("<span aria-hidden=\\"true\\">·</span>") + "</div>" : "";
	}
	function extractHtml(c) {
		if (!c.textPreview) return "";
		return '<pre class="extract">' + esc(c.textPreview) + "</pre>";
	}
	function titleHtml(c) {
		return c.title ? '<p class="pagetitle">' + esc(c.title) + "</p>" : "";
	}
	function noteHtml(c) {
		if (!c.note) return "";
		var cls = (c.outcome === "error" || c.outcome === "rejected" || c.outcome === "thin") ? "errtext" : "note";
		return '<p class="' + cls + '">' + esc(c.note) + "</p>";
	}

	function openCellDialog(kind, url, mode) {
		var entries = entriesFor(mode, kind, url).slice().reverse();
		if (!entries.length) return;
		var body = entries.map(function (e) {
			return '<div class="runblock"><div class="runmeta">' + chipHtml(e.cell) +
				'<span class="when">' + fmtDate(e.run.startedAt) + " · " + e.run.mode + "</span></div>" +
				cellFacts(e.cell) + titleHtml(e.cell) + noteHtml(e.cell) + extractHtml(e.cell) + "</div>";
		}).join("");
		cellDialog.innerHTML = '<div class="dlg-head"><h3>' + esc(kind) + " — " + esc(shortUrl(url)) +
			'</h3><button type="button" class="dlg-close" data-close>close</button></div>' +
			'<div class="dlg-body">' + body + '<p class="plabel">' + esc(url) + "</p></div>";
		cellDialog.showModal();
	}

	function openUrlDialog(url, mode) {
		var kinds = [];
		runs.forEach(function (run) {
			if (run.mode !== mode) return;
			run.providers.forEach(function (p) {
				if (kinds.indexOf(p.kind) === -1) kinds.push(p.kind);
			});
		});
		var cards = kinds.map(function (kind) {
			var entries = entriesFor(mode, kind, url);
			if (!entries.length)
				return '<div class="card"><div class="runmeta"><span class="plabel">' + esc(kind) + " — no data</span></div></div>";
			var latest = entries[entries.length - 1].cell;
			var rate = entries.length > 1
				? '<span class="when">' + entries.filter(function (e) { return isSuccess(e.cell); }).length + "/" + entries.length + "</span>"
				: "";
			return '<div class="card"><div class="runmeta">' + chipHtml(latest) +
				'<span class="pname">' + esc(kind) + "</span>" + rate + stripHtml(entries) + "</div>" +
				cellFacts(latest) + titleHtml(latest) + noteHtml(latest) + extractHtml(latest) + "</div>";
		}).join("");
		urlDialog.innerHTML = '<div class="dlg-head"><h3>' + esc(url) +
			'</h3><button type="button" class="dlg-close" data-close>close</button></div>' +
			'<div class="dlg-body"><div class="cards">' + cards + "</div></div>";
		urlDialog.showModal();
	}

	document.addEventListener("click", function (ev) {
		var t = ev.target;
		if (!(t instanceof Element)) return;
		if (t.closest("[data-close]")) {
			var d = t.closest("dialog");
			if (d) d.close();
			return;
		}
		if (t instanceof HTMLDialogElement && ev.target === t) { t.close(); return; }
		var cell = t.closest("td.cell[data-kind]");
		if (cell) { openCellDialog(cell.dataset.kind, cell.dataset.url, cell.dataset.mode); return; }
		var urlh = t.closest("th.urlh[data-url]");
		if (urlh) { openUrlDialog(urlh.dataset.url, urlh.dataset.mode); return; }
	});
	document.addEventListener("keydown", function (ev) {
		if (ev.key !== "Enter" && ev.key !== " ") return;
		var t = ev.target;
		if (!(t instanceof Element)) return;
		var cell = t.closest('td.cell[data-kind], th.urlh[data-url]');
		if (cell && cell === t) {
			ev.preventDefault();
			if (cell.dataset.kind) openCellDialog(cell.dataset.kind, cell.dataset.url, cell.dataset.mode);
			else openUrlDialog(cell.dataset.url, cell.dataset.mode);
		}
	});

	// latency sort
	document.querySelectorAll("table.latency").forEach(function (table) {
		var tbody = table.querySelector("tbody");
		table.querySelectorAll("th").forEach(function (th) {
			th.addEventListener("click", function () {
				var key = th.dataset.key, type = th.dataset.type;
				var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
				var dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
				table.querySelectorAll("th").forEach(function (h) { h.removeAttribute("aria-sort"); });
				th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
				rows.sort(function (a, b) {
					var av = a.getAttribute("data-" + key) || "";
					var bv = b.getAttribute("data-" + key) || "";
					if (type === "num") return (parseFloat(av) - parseFloat(bv)) * dir;
					return av.localeCompare(bv) * dir;
				});
				rows.forEach(function (r) { tbody.appendChild(r); });
			});
		});
	});

	// chain picker — one instance per mode section
	document.querySelectorAll(".chain-card").forEach(function (card) {
		var mode = card.dataset.mode;
		var order = [];
		var orderEl = card.querySelector(".chain-order");
		var resultEl = card.querySelector(".chain-result");
		var kinds = [];
		runs.forEach(function (run) {
			if (run.mode !== mode) return;
			run.providers.forEach(function (p) { if (kinds.indexOf(p.kind) === -1) kinds.push(p.kind); });
		});
		var urls = [];
		runs.forEach(function (run) {
			if (run.mode !== mode) return;
			run.urls.forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
		});
		function medFor(kind, url, succOnly) {
			var xs = entriesFor(mode, kind, url).filter(function (e) {
				if (e.cell.outcome === "skipped") return false;
				return !succOnly || isSuccess(e.cell);
			}).map(function (e) { return e.cell.ms; }).filter(function (m) { return m !== undefined; });
			return median(xs);
		}
		function providerMed(kind) {
			var xs = [];
			urls.forEach(function (u) {
				entriesFor(mode, kind, u).forEach(function (e) {
					if (e.cell.outcome !== "skipped" && e.cell.ms !== undefined) xs.push(e.cell.ms);
				});
			});
			return median(xs);
		}
		function everOk(kind, url) {
			return entriesFor(mode, kind, url).some(function (e) { return isSuccess(e.cell); });
		}
		function render() {
			orderEl.innerHTML = order.map(function (kind, i) {
				return '<li><span class="ord">' + (i + 1) + '</span><button type="button" data-drop="' + esc(kind) + '">' + esc(kind) + "</button></li>";
			}).join("");
			if (!order.length) {
				resultEl.innerHTML = '<p class="plabel">pick providers above to build a chain</p>';
				return;
			}
			var rows = "", covered = 0, worst = 0;
			urls.forEach(function (u) {
				var est = 0, winner = null;
				for (var i = 0; i < order.length; i++) {
					var kind = order[i];
					var m = medFor(kind, u, false);
					if (m === undefined) m = providerMed(kind);
					if (everOk(kind, u)) {
						var wm = medFor(kind, u, true);
						est += wm === undefined ? m : wm;
						winner = kind;
						break;
					}
					est += m === undefined ? 0 : m;
				}
				if (winner) {
					covered++;
					worst = Math.max(worst, est);
					rows += "<tr><td>" + esc(shortUrl(u)) + '</td><td class="num">' + fmtMs(est) + "</td><td>" + esc(winner) + "</td></tr>";
				} else {
					worst = Math.max(worst, est);
					rows += "<tr><td>" + esc(shortUrl(u)) + '</td><td class="num">' + fmtMs(est) + '</td><td class="miss">miss</td></tr>';
				}
			});
			resultEl.innerHTML = '<table><thead><tr><th>url</th><th>est</th><th>first success</th></tr></thead><tbody>' + rows + "</tbody></table>" +
				'<p class="meta">coverage ' + covered + "/" + urls.length + " · worst case " + fmtMs(worst) + " · estimate: medians, first-success-wins</p>";
		}
		card.addEventListener("click", function (ev) {
			var t = ev.target;
			if (!(t instanceof Element)) return;
			var chip = t.closest(".chain-chip");
			if (chip) {
				var kind = chip.dataset.kind;
				if (order.indexOf(kind) === -1) order.push(kind);
				render();
				return;
			}
			var drop = t.closest("[data-drop]");
			if (drop) {
				order = order.filter(function (k) { return k !== drop.dataset.drop; });
				render();
			}
		});
		render();
	});
})();
`;

// ---------- CLI ----------

export function defaultOutPath(): string {
	return `${recordsDir()}/bench-view.html`;
}

function main(): void {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			out: { type: "string" },
		},
	});
	const runs = readRunRecords();
	if (runs.length === 0) {
		process.stderr.write(
			"no run records — run `bun scripts/bench-fetch.ts` first\n",
		);
		process.exit(1);
	}
	const out = values.out ?? defaultOutPath();
	durableWriteFile(out, buildHtml(runs));
	const url = new URL(`file://${out}`).href;
	process.stdout.write(`${runs.length} runs → ${out}\nopen: ${url}\n`);
}

if (import.meta.main) {
	try {
		main();
	} catch (err) {
		process.stderr.write(`bench-view failed: ${err instanceof Error ? err.message : err}\n`);
		process.exit(1);
	}
}
