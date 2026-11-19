// Provider benchmark for the fetch tool (#754): every fetch kind —
// local, jina, tavily, firecrawl, parallel — run ALONE against a set of
// bot-protected targets, so each cell answers "can this provider get
// this page" with no fallback chain hiding the loser.
//
// Drives the same code the tool runs — runFetchChain over a
// single-entry chain — against the real auth.jsonl, so an "ok" here
// means that provider survives the page in production. Auth record
// names come from the operator's configured fetch chain when the kind
// is listed there, else the kind's conventional default; jina runs
// keyless unless configured. A provider whose record is missing or
// fails to resolve is "skipped", not failed. Values never print.
//
// Run from the repo root:
//
//   bun scripts/bench-fetch.ts [extra-url ...]
//   bun scripts/bench-fetch.ts --providers=local,jina https://…
//
// One vendor extraction call per keyed provider per URL (billed).
// GOBLIN_HOME is sandboxed to a tmp dir unless the operator set it —
// PDF/cache writes from the probe stay out of the real state dir, while
// auth.jsonl and goblin.json5 are still read from the real home.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authFile } from "../src/auth-parse.ts";
import { loadAuthFile, type AuthStore } from "../src/auth.ts";
import { parseConfigFile } from "../src/config.ts";
import { authDefaults, fetchKinds, type Config, type FetchConfig } from "../src/config-schema.ts";
import { runFetchChain } from "../src/agent/tools/fetch.ts";
import { clampChars } from "../src/agent/tools/web.ts";
import { goblinHome } from "../src/goblin-home.ts";
import { setLogStream } from "../src/log.ts";

// Capture real-home paths BEFORE sandboxing: goblinHome() reads the env
// lazily, so any paths.* call after the override would point at tmp.
const AUTH_FILE = process.env.GOBLIN_BENCH_AUTH_FILE ?? authFile();
const CONFIG_FILE = join(goblinHome(), "goblin.json5");
process.env.GOBLIN_HOME ??= mkdtempSync(join(tmpdir(), "goblin-bench-"));

// Runtime diagnostics (web fetch warn lines) off the report's stdout.
setLogStream(process.stderr);

type FetchKind = (typeof fetchKinds)[number];

// Targets picked for bot-detection hardness, not content. example.com
// is the control: a provider failing it is broken, not blocked.
const DEFAULT_URLS = [
	"https://example.com/",
	"https://www.reuters.com/",
	"https://archive.ph/",
	"https://www.wsj.com/",
	"https://www.g2.com/",
	"https://www.indeed.com/",
	"https://x.com/",
];

interface Plan {
	kind: FetchKind;
	entry: FetchConfig[number];
	authName?: string | undefined;
	skip?: string | undefined;
}

interface Cell {
	outcome: "ok" | "pdf" | "blocked" | "thin" | "rejected" | "error" | "skipped";
	chars?: number | undefined;
	status?: number | undefined;
	ms?: number | undefined;
	note?: string | undefined;
}

// A 200 holding a bot-check interstitial is a block, not a fetch — the
// page text is the challenge, not the content. Title is the strongest
// signal; the body head catches untitled challenge shells.
const BLOCK_TITLE = /just a moment|security check|attention required|access denied|verify you|are you a robot|challenge-platform/i;
const BLOCK_HEAD = /just a moment|attention required|verify you are human|checking your browser|review the security of your connection/i;

function isBlockPage(title: string, text: string): boolean {
	return BLOCK_TITLE.test(title) || BLOCK_HEAD.test(text.slice(0, 500));
}

function parseArgs(argv: string[]): { kinds: FetchKind[]; extraUrls: string[] } {
	const picked = new Set<FetchKind>();
	const extraUrls: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith("--providers=")) {
			for (const name of arg.slice("--providers=".length).split(",")) {
				const k = name.trim();
				if (!(fetchKinds as readonly string[]).includes(k)) {
					throw new Error(`unknown provider "${k}" — pick from ${fetchKinds.join(", ")}`);
				}
				picked.add(k as FetchKind);
			}
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
		if (!/^https?:\/\//.test(arg)) throw new Error(`not an http(s) url: ${arg}`);
		extraUrls.push(arg);
	}
	const kinds = fetchKinds.filter((k) => picked.size === 0 || picked.has(k));
	return { kinds, extraUrls };
}

// A broken config costs the bench nothing but auth names — warn and
// fall back to conventional record names.
function readConfig(): Config | null {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_FILE, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return null;
	}
	try {
		return parseConfigFile(raw);
	} catch (err) {
		process.stderr.write(
			`bench: ${CONFIG_FILE} failed to parse (${(err as Error).message}) — using conventional auth names\n`,
		);
		return null;
	}
}

function planFor(kind: FetchKind, configuredAuth: string | undefined): Plan {
	switch (kind) {
		case "local":
			return { kind, entry: { kind: "local" } };
		case "jina":
			return {
				kind,
				entry: configuredAuth ? { kind: "jina", auth: configuredAuth } : { kind: "jina" },
				authName: configuredAuth,
			};
		case "tavily":
		case "firecrawl":
		case "parallel": {
			const authName = configuredAuth ?? authDefaults[kind];
			return { kind, entry: { kind, auth: authName }, authName };
		}
	}
}

async function runCell(plan: Plan, auth: AuthStore, url: string): Promise<Cell> {
	if (plan.skip !== undefined) return { outcome: "skipped", note: plan.skip };
	const started = performance.now();
	try {
		const { extracted, failures } = await runFetchChain([plan.entry], auth, url);
		const ms = Math.round(performance.now() - started);
		if ("error" in extracted) {
			const summary = failures.map((f) => f.error).join("; ");
			return {
				outcome: extracted.kind === "empty-extraction" ? "thin" : "rejected",
				status: extracted.meta.status,
				ms,
				note: summary || extracted.error,
			};
		}
		if (extracted.pdf) {
			return { outcome: "pdf", chars: extracted.pdf.size, status: extracted.meta.status, ms };
		}
		const blocked = isBlockPage(extracted.title, extracted.text);
		return {
			outcome: blocked ? "blocked" : "ok",
			chars: extracted.text.length,
			status: extracted.meta.status,
			ms,
			note: extracted.title ? clampChars(extracted.title, 60) : undefined,
		};
	} catch (err) {
		const note = (err as Error).message.replace(/^fetch failed — /, "");
		return { outcome: "error", ms: Math.round(performance.now() - started), note };
	}
}

function urlLabel(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname === "/" ? "" : u.pathname;
		return clampChars(`${u.hostname.replace(/^www\./, "")}${path}`, 20);
	} catch {
		return clampChars(url, 20);
	}
}

function printCell(kind: FetchKind, cell: Cell): void {
	const status = cell.status !== undefined ? String(cell.status).padStart(4) : "    ";
	const unit = cell.outcome === "pdf" ? " B" : "ch";
	const chars =
		cell.chars !== undefined
			? `${cell.chars.toLocaleString("en-US").padStart(8)} ${unit}`
			: "          ";
	const ms = cell.ms !== undefined ? `${(cell.ms / 1000).toFixed(1).padStart(6)}s` : "       ";
	const note = cell.note ? `  ${clampChars(cell.note, 90)}` : "";
	console.log(`  ${kind.padEnd(10)}${cell.outcome.padEnd(8)} ${status} ${chars} ${ms}${note}`);
}

function shortOutcome(cell: Cell): string {
	switch (cell.outcome) {
		case "ok":
			return cell.chars !== undefined && cell.chars >= 10_000
				? `ok ${Math.round(cell.chars / 1000)}k`
				: "ok";
		case "pdf":
			return "pdf";
		case "blocked":
			return "BLOCKED";
		case "skipped":
			return "skip";
		default:
			return cell.outcome;
	}
}

async function main(): Promise<void> {
	const { kinds, extraUrls } = parseArgs(process.argv.slice(2));
	const urls = [...DEFAULT_URLS, ...extraUrls];
	const auth = loadAuthFile(AUTH_FILE);
	const config = readConfig();

	const plans = kinds.map((kind) => {
		const configured = config?.fetch?.find((e) => e.kind === kind);
		const configuredAuth =
			configured && "auth" in configured ? configured.auth : undefined;
		return planFor(kind, configuredAuth);
	});
	for (const plan of plans) {
		if (plan.authName === undefined) continue;
		if (!auth.has(plan.authName)) {
			plan.skip = `no auth.jsonl record "${plan.authName}"`;
			continue;
		}
		try {
			await auth.resolve(plan.authName);
		} catch (err) {
			plan.skip = `auth "${plan.authName}" failed to resolve — ${(err as Error).message}`;
		}
	}

	console.log(`fetch provider benchmark — ${urls.length} urls × ${plans.length} providers`);
	console.log(`auth: ${AUTH_FILE}`);
	for (const plan of plans) {
		const via = plan.kind === "local" ? "" : plan.authName ? ` (auth "${plan.authName}")` : " (keyless)";
		console.log(`  ${plan.kind}${via}${plan.skip ? ` — skipped: ${plan.skip}` : ""}`);
	}

	const grid = new Map<FetchKind, Cell[]>();
	for (const url of urls) {
		console.log(`\n${url}`);
		const cells = await Promise.all(plans.map((plan) => runCell(plan, auth, url)));
		for (const [i, plan] of plans.entries()) {
			const cell = cells[i]!;
			const row = grid.get(plan.kind) ?? [];
			row.push(cell);
			grid.set(plan.kind, row);
			printCell(plan.kind, cell);
		}
	}

	const labels = urls.map(urlLabel);
	const colW = Math.max(8, ...labels.map((l) => l.length)) + 2;
	console.log("\nsummary");
	console.log(`  ${"".padEnd(10)}${labels.map((l) => l.padEnd(colW)).join("")}score`);
	for (const plan of plans) {
		const cells = grid.get(plan.kind) ?? [];
		const ok = cells.filter((c) => c.outcome === "ok" || c.outcome === "pdf").length;
		const line = cells.map((c) => shortOutcome(c).padEnd(colW)).join("");
		console.log(`  ${plan.kind.padEnd(10)}${line}${ok}/${cells.length}`);
	}
	const anyRow = urls
		.map((_, i) =>
			plans.some((p) => {
				const c = grid.get(p.kind)?.[i];
				return c?.outcome === "ok" || c?.outcome === "pdf";
			})
				? "ok".padEnd(colW)
				: "none".padEnd(colW),
		)
		.join("");
	console.log(`  ${"any".padEnd(10)}${anyRow}`);
}

try {
	await main();
} catch (err) {
	console.error("bench failed:", err instanceof Error ? err.message : err);
	process.exit(1);
}
