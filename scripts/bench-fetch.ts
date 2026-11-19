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
// Candidates (CANDIDATES below) are providers auditioning for a schema
// kind — the bench runs them through a bench-local extractor against
// the same targets and the same thin/blocked rules, marked "candidate"
// in the provider list. A candidate that earns its place gets a real
// extractor in src/agent/tools/fetch.ts and a schema kind later.
//
// Run from the repo root:
//
//   bun scripts/bench-fetch.ts [extra-url ...]
//   bun scripts/bench-fetch.ts --live            # force every no-cache knob
//   bun scripts/bench-fetch.ts --providers=local,jina https://…
//
// --live answers "can it beat the bot wall RIGHT NOW" — production rows
// send no freshness params (what the tool ships), so live cells run
// bench-local extractors with each provider's no-cache setting:
// tinyfish ttl=0, jina X-No-Cache, firecrawl maxAge=0, parallel
// fetch_policy (its max_age floor is 600s — flagged in the row note).
// tavily and tinyfish-cli have no knob: their cells keep the default
// wire and a "may be cached" note. local needs no flag — it never
// caches.
//
// One vendor extraction call per keyed provider per URL (billed).
// GOBLIN_HOME is sandboxed to a tmp dir unless the operator set it —
// PDF/cache writes from the probe stay out of the real state dir, while
// auth.jsonl and goblin.json5 are still read from the real home.
//
// Every run also writes one JSON record (bench-records/, gitignored —
// names and measurements only, never key values) so history survives:
// scripts/bench-fetch-view.ts turns the pile of records into one
// self-contained HTML viewer (matrix, flakiness, drill-downs, coverage).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FetchChainOutcome,
	type FetchFailure,
	runFetchChain,
} from "../src/agent/tools/fetch.ts";
import {
	clampChars,
	fetchOk,
	postJson,
	readJson,
	resMeta,
	str,
} from "../src/agent/tools/web.ts";
import { type AuthStore, loadAuthFile } from "../src/auth.ts";
import { authFile } from "../src/auth-parse.ts";
import { parseConfigFile } from "../src/config.ts";
import {
	authDefaults,
	type Config,
	type FetchConfig,
	fetchKinds,
} from "../src/config-schema.ts";
import { goblinHome } from "../src/goblin-home.ts";
import { setLogStream } from "../src/log.ts";
import { boundedRun, spawnProc } from "../src/proc.ts";
import { type BenchCell, writeRunRecord } from "./bench-fetch-record.ts";

// Capture real-home paths BEFORE sandboxing: goblinHome() reads the env
// lazily, so any paths.* call after the override would point at tmp.
const AUTH_FILE = process.env.GOBLIN_BENCH_AUTH_FILE ?? authFile();
const CONFIG_FILE = join(goblinHome(), "goblin.json5");
process.env.GOBLIN_HOME ??= mkdtempSync(join(tmpdir(), "goblin-bench-"));

// Runtime diagnostics (web fetch warn lines) off the report's stdout.
setLogStream(process.stderr);

type FetchKind = (typeof fetchKinds)[number];
type BenchKind = FetchKind | keyof typeof CANDIDATES;
// runFetchChain's result union: Extracted ({title,text,pdf?,meta}) or
// Rejected ({error,kind,meta}) — the shape candidate execs reproduce.
type ExtractedOrRejected = FetchChainOutcome["extracted"];
type Fetched = Exclude<ExtractedOrRejected, { error: string }>;
// Mirrors fetch.ts's MIN_EXTRACT — candidates get the same thin rule.
const MIN_EXTRACT = 200;

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

interface ExecResult {
	extracted: ExtractedOrRejected;
	failures: FetchFailure[];
}

type PlanExec = (auth: AuthStore, url: string) => Promise<ExecResult>;

interface Plan {
	kind: string;
	exec: PlanExec;
	// Present when the provider's API exposes a freshness knob — the
	// bench-local wire that forces it. Absent → --live keeps the default
	// wire and flags the cells as possibly cached.
	execLive?: PlanExec | undefined;
	// Appended to live-cell notes (e.g. parallel's 10-minute floor).
	liveNote?: string | undefined;
	authName?: string | undefined;
	skip?: string | undefined;
	candidate?: true | undefined;
	// Overrides the header's "(auth …)/(keyless)" tag (e.g. "via mcporter").
	via?: string | undefined;
}

// A run cell IS the record cell — the viewer reads what the bench saw.
type Cell = BenchCell;
// Extract preview kept per cell for the viewer's drill-down.
const TEXT_PREVIEW = 1000;

// A 200 holding a bot-check interstitial is a block, not a fetch — the
// page text is the challenge, not the content. Title is the strongest
// signal; the body head catches untitled challenge shells.
const BLOCK_TITLE =
	/just a moment|security check|attention required|access denied|verify you|are you a robot|challenge-platform/i;
const BLOCK_HEAD =
	/just a moment|attention required|verify you are human|checking your browser|review the security of your connection/i;

function isBlockPage(title: string, text: string): boolean {
	return BLOCK_TITLE.test(title) || BLOCK_HEAD.test(text.slice(0, 500));
}

// ---------- candidates ----------

// POST api.fetch.tinyfish.ai (docs.tinyfish.ai/tinyfetch): per-URL
// failures land in errors[] on a 200 — never an HTTP error — so a
// blocked page must be read out of the body. No ttl: production would
// accept TinyFish's cache too, and the bench scores what the tool
// would get — a cache hit IS a fetch that worked. Measured 2026-11-19:
// ttl:0 (live only) turns the reuters ok into bot_blocked, and the
// MCP surface behaves identically — one backend, one cache.
const TINYFETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
const TIMEOUT_MS = 30_000;

async function tinyfetchExtract(
	url: string,
	key: string,
	live = false,
): Promise<Fetched> {
	const { data, meta } = await postJson(
		"tinyfish",
		TINYFETCH_ENDPOINT,
		{ "X-API-Key": key },
		{ urls: [url], format: "markdown", ...(live ? { ttl: 0 } : {}) },
		TIMEOUT_MS,
	);
	const body = data as { results?: unknown[]; errors?: unknown[] };
	const row = (body.results ?? [])[0] as Record<string, unknown> | undefined;
	const failure = (body.errors ?? [])[0] as Record<string, unknown> | undefined;
	if (!row) {
		throw new Error(
			`tinyfish: extraction failed — ${str(failure?.error) || "no result"}`,
		);
	}
	return { title: str(row.title), text: str(row.text), meta };
}

// ---------- live extractors (--live) ----------
//
// Bench-local wires that force each provider's no-cache knob. They
// duplicate fetch.ts's request shapes on purpose: production sends no
// freshness params, so these measure provider capability, not the
// shipped wire. Each mirrors its extractor in src/agent/tools/fetch.ts
// with only the knob added.

const LIVE_BASES = {
	jina: "https://r.jina.ai",
	firecrawl: "https://api.firecrawl.dev",
	parallel: "https://api.parallel.ai",
} as const;

async function jinaLive(
	url: string,
	key: string | undefined,
): Promise<Fetched> {
	const res = await fetchOk(
		"jina",
		`${LIVE_BASES.jina}/${url}`,
		{
			headers: {
				Accept: "application/json",
				"X-No-Cache": "true",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
		},
		TIMEOUT_MS,
	);
	const { data, bytes } = await readJson("jina", res);
	const row = (data as { data?: Record<string, unknown> }).data;
	return {
		title: str(row?.title),
		text: str(row?.content),
		meta: resMeta(res, bytes),
	};
}

async function firecrawlLive(
	url: string,
	key: string | undefined,
): Promise<Fetched> {
	const { data, meta } = await postJson(
		"firecrawl",
		`${LIVE_BASES.firecrawl}/v2/scrape`,
		key ? { Authorization: `Bearer ${key}` } : {},
		{ url, formats: ["markdown"], maxAge: 0 },
		TIMEOUT_MS,
	);
	const body = data as {
		success?: boolean;
		error?: string;
		data?: Record<string, unknown>;
	};
	if (body.success === false || !body.data) {
		throw new Error(`firecrawl: ${str(body.error) || "scrape failed"}`);
	}
	const metadata = body.data.metadata as Record<string, unknown> | undefined;
	return { title: str(metadata?.title), text: str(body.data.markdown), meta };
}

async function parallelLive(
	url: string,
	key: string | undefined,
): Promise<Fetched> {
	const { data, meta } = await postJson(
		"parallel",
		`${LIVE_BASES.parallel}/v1/extract`,
		key ? { Authorization: `Bearer ${key}` } : {},
		{
			urls: [url],
			advanced_settings: {
				full_content: true,
				// max_age_seconds floor is 600 — no true live mode exists.
				fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true },
			},
		},
		TIMEOUT_MS,
	);
	const body = data as { results?: unknown[]; errors?: unknown[] };
	const row = (body.results ?? [])[0] as Record<string, unknown> | undefined;
	if (!row) {
		const err = (body.errors ?? [])[0] as Record<string, unknown> | undefined;
		const status =
			typeof err?.http_status_code === "number"
				? ` ${err.http_status_code}`
				: "";
		throw new Error(
			`parallel: extraction failed — ${str(err?.content) || str(err?.error_type) || "no result"}${status}`,
		);
	}
	const text = str(row.full_content);
	if (!text)
		throw new Error("parallel: no full content (site may block its crawler)");
	return { title: str(row.title), text, meta };
}

// Candidates share runFetchChain's thin rule: under MIN_EXTRACT the
// page text didn't arrive, whatever the transport said.
function scored(extracted: Fetched, kind: string): ExecResult {
	const chars = extracted.text.trim().length;
	if (chars < MIN_EXTRACT) {
		const error = `${kind}: almost no text (${chars} chars)`;
		return {
			extracted: { error, kind: "empty-extraction", meta: extracted.meta },
			failures: [{ kind, error }],
		};
	}
	return { extracted, failures: [] };
}

function tinyfishPlan(): Plan {
	return {
		kind: "tinyfish",
		authName: "tinyfish",
		candidate: true,
		exec: async (auth, url) =>
			scored(
				await tinyfetchExtract(url, await auth.resolve("tinyfish")),
				"tinyfish",
			),
		execLive: async (auth, url) =>
			scored(
				await tinyfetchExtract(url, await auth.resolve("tinyfish"), true),
				"tinyfish",
			),
	};
}

// tinyfish-mcp: the same account through its MCP surface. Same backend
// as the REST endpoint — measured 2026-11-19: ttl=0 returns bot_blocked
// on reuters identically, and default calls return byte-identical
// cached pages. Kept as its own row because the wire differs (mcporter
// wrapper injects the key into the child env — no auth.jsonl record
// and the key never enters this process) and to catch any divergence.
const MCP_TIMEOUT_MS = 75_000;
const MCP_OUTPUT_CAP = 8 * 1024 * 1024;

function tinyfishMcpPlan(): Plan {
	return {
		kind: "tinyfish-mcp",
		candidate: true,
		via: " (via mcporter)",
		exec: async (_auth, url) => {
			const extracted = await fetchViaSpawn(
				[
					"mcporter",
					"call",
					"tinyfish.fetch_content",
					`urls=["${url}"]`,
					"format=markdown",
					"--timeout",
					"60000",
				],
				"tinyfish-mcp",
			);
			return scored(extracted, "tinyfish-mcp");
		},
		execLive: async (_auth, url) =>
			scored(
				await fetchViaSpawn(
					[
						"mcporter",
						"call",
						"tinyfish.fetch_content",
						`urls=["${url}"]`,
						"format=markdown",
						"ttl=0",
						"--timeout",
						"60000",
					],
					"tinyfish-mcp",
				),
				"tinyfish-mcp",
			),
	};
}

// tinyfish-cli: @tiny-fish/cli `fetch content get` — the SDK calls the
// same api.fetch.tinyfish.ai endpoint with default caching (no ttl
// flag exists on the CLI). Its score should match `tinyfish` exactly;
// any gap is CLI-only behavior worth knowing about. The key rides
// pass-keys' mcporter profile into the CLI's env.
function tinyfishCliPlan(): Plan {
	return {
		kind: "tinyfish-cli",
		candidate: true,
		via: " (via pass-keys+bunx)",
		exec: async (_auth, url) => {
			const extracted = await fetchViaSpawn(
				[
					"pass-keys",
					"run",
					"mcporter",
					"--",
					"bunx",
					"@tiny-fish/cli@0.59.0",
					"fetch",
					"content",
					"get",
					url,
				],
				"tinyfish-cli",
			);
			return scored(extracted, "tinyfish-cli");
		},
	};
}

// Spawn-and-parse for the CLI/MCP candidates: both answer the same
// {results, errors} envelope on stdout. The wire carries no HTTP
// status — meta.status is report-only.
async function fetchViaSpawn(argv: string[], kind: string): Promise<Fetched> {
	const proc = spawnProc(argv);
	const out = await boundedRun(proc, {
		timeoutMs: MCP_TIMEOUT_MS,
		maxOutput: MCP_OUTPUT_CAP,
	});
	if (out.timedOut) throw new Error(`${kind}: call timed out`);
	if (out.exitCode !== 0) {
		throw new Error(
			`${kind}: exited ${out.exitCode} — ${clampChars(out.stderr.trim(), 120)}`,
		);
	}
	const body = JSON.parse(out.stdout) as {
		results?: unknown[];
		errors?: unknown[];
	};
	const row = (body.results ?? [])[0] as Record<string, unknown> | undefined;
	const failure = (body.errors ?? [])[0] as Record<string, unknown> | undefined;
	if (!row) {
		throw new Error(
			`${kind}: extraction failed — ${str(failure?.error) || "no result"}`,
		);
	}
	return {
		title: str(row.title),
		text: str(row.text),
		meta: { status: 200, contentType: "", bytes: out.stdout.length },
	};
}

const CANDIDATES = {
	tinyfish: tinyfishPlan,
	"tinyfish-mcp": tinyfishMcpPlan,
	"tinyfish-cli": tinyfishCliPlan,
} as const;

const BENCH_KINDS: readonly string[] = [
	...fetchKinds,
	...Object.keys(CANDIDATES),
];
const KIND_W = Math.max(...BENCH_KINDS.map((k) => k.length)) + 1;

function parseArgs(argv: string[]): {
	kinds: BenchKind[];
	extraUrls: string[];
	live: boolean;
} {
	const picked = new Set<string>();
	const extraUrls: string[] = [];
	let live = false;
	for (const arg of argv) {
		if (arg === "--live") {
			live = true;
			continue;
		}
		if (arg.startsWith("--providers=")) {
			for (const name of arg.slice("--providers=".length).split(",")) {
				const k = name.trim();
				if (!BENCH_KINDS.includes(k)) {
					throw new Error(
						`unknown provider "${k}" — pick from ${BENCH_KINDS.join(", ")}`,
					);
				}
				picked.add(k);
			}
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
		if (!/^https?:\/\//.test(arg))
			throw new Error(`not an http(s) url: ${arg}`);
		extraUrls.push(arg);
	}
	const kinds = BENCH_KINDS.filter(
		(k) => picked.size === 0 || picked.has(k),
	) as BenchKind[];
	return { kinds, extraUrls, live };
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
	const chain =
		(entry: FetchConfig[number]): Plan["exec"] =>
		async (auth, url) => {
			const { extracted, failures } = await runFetchChain([entry], auth, url);
			return { extracted, failures };
		};
	switch (kind) {
		case "local": {
			const exec = chain({ kind: "local" });
			// local never caches — the same wire is already live.
			return { kind, exec, execLive: exec };
		}
		case "jina":
			return {
				kind,
				exec: chain(
					configuredAuth
						? { kind: "jina", auth: configuredAuth }
						: { kind: "jina" },
				),
				authName: configuredAuth,
				execLive: async (auth, url) =>
					scored(
						await jinaLive(
							url,
							configuredAuth ? await auth.resolve(configuredAuth) : undefined,
						),
						"jina",
					),
			};
		case "tavily": {
			const authName = configuredAuth ?? authDefaults.tavily;
			// /extract exposes no freshness knob — cells flagged in --live.
			return {
				kind,
				exec: chain({ kind: "tavily", auth: authName }),
				authName,
			};
		}
		case "firecrawl": {
			const authName = configuredAuth ?? authDefaults.firecrawl;
			return {
				kind,
				exec: chain({ kind: "firecrawl", auth: authName }),
				authName,
				execLive: async (auth, url) =>
					scored(
						await firecrawlLive(url, await auth.resolve(authName)),
						"firecrawl",
					),
			};
		}
		case "parallel": {
			const authName = configuredAuth ?? authDefaults.parallel;
			return {
				kind,
				exec: chain({ kind: "parallel", auth: authName }),
				authName,
				execLive: async (auth, url) =>
					scored(
						await parallelLive(url, await auth.resolve(authName)),
						"parallel",
					),
				liveNote: "max_age floor 600s — may serve ≤10-min copy",
			};
		}
	}
}

async function runCell(
	plan: Plan,
	auth: AuthStore,
	url: string,
	live: boolean,
): Promise<Cell> {
	if (plan.skip !== undefined) return { outcome: "skipped", note: plan.skip };
	const started = performance.now();
	try {
		const fn = live ? (plan.execLive ?? plan.exec) : plan.exec;
		const { extracted, failures } = await fn(auth, url);
		const ms = Math.round(performance.now() - started);
		let cell: Cell;
		if ("error" in extracted) {
			const summary = failures.map((f) => f.error).join("; ");
			cell = {
				outcome: extracted.kind === "empty-extraction" ? "thin" : "rejected",
				status: extracted.meta.status,
				ms,
				note: summary || extracted.error,
			};
		} else if (extracted.pdf) {
			cell = {
				outcome: "pdf",
				chars: extracted.pdf.size,
				status: extracted.meta.status,
				ms,
			};
		} else {
			const blocked = isBlockPage(extracted.title, extracted.text);
			cell = {
				outcome: blocked ? "blocked" : "ok",
				chars: extracted.text.length,
				status: extracted.meta.status,
				ms,
				note: extracted.title ? clampChars(extracted.title, 60) : undefined,
				title: extracted.title || undefined,
				textPreview: extracted.text.slice(0, TEXT_PREVIEW),
			};
		}
		if (live) {
			const caveat = plan.execLive
				? plan.liveNote
				: "no live knob — may be cached";
			if (caveat) cell.note = cell.note ? `${caveat} · ${cell.note}` : caveat;
			if (!plan.execLive) cell.maybeCached = true;
		}
		return cell;
	} catch (err) {
		const note = (err as Error).message.replace(/^fetch failed — /, "");
		return {
			outcome: "error",
			ms: Math.round(performance.now() - started),
			note,
		};
	}
}

// Shared by the terminal header and the run record.
function viaTag(plan: Plan): string {
	return (
		plan.via ??
		(plan.kind === "local"
			? ""
			: plan.authName
				? ` (auth "${plan.authName}")`
				: " (keyless)")
	);
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

function printCell(kind: string, cell: Cell): void {
	const status =
		cell.status !== undefined ? String(cell.status).padStart(4) : "    ";
	const unit = cell.outcome === "pdf" ? " B" : "ch";
	const chars =
		cell.chars !== undefined
			? `${cell.chars.toLocaleString("en-US").padStart(8)} ${unit}`
			: "          ";
	const ms =
		cell.ms !== undefined
			? `${(cell.ms / 1000).toFixed(1).padStart(6)}s`
			: "       ";
	const note = cell.note ? `  ${clampChars(cell.note, 90)}` : "";
	console.log(
		`  ${kind.padEnd(KIND_W)}${cell.outcome.padEnd(8)} ${status} ${chars} ${ms}${note}`,
	);
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
	const startedAt = new Date().toISOString();
	const { kinds, extraUrls, live } = parseArgs(process.argv.slice(2));
	const urls = [...DEFAULT_URLS, ...extraUrls];
	const auth = loadAuthFile(AUTH_FILE);
	const config = readConfig();

	const plans = kinds.map((kind): Plan => {
		if (kind in CANDIDATES)
			return CANDIDATES[kind as keyof typeof CANDIDATES]();
		const configured = config?.fetch?.find((e) => e.kind === kind);
		const configuredAuth =
			configured && "auth" in configured ? configured.auth : undefined;
		return planFor(kind as FetchKind, configuredAuth);
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

	console.log(
		`fetch provider benchmark — ${urls.length} urls × ${plans.length} providers`,
	);
	console.log(
		`mode: ${live ? "live — forced no-cache where the API has a knob" : "default — provider cache accepted (production wire)"}`,
	);
	console.log(`auth: ${AUTH_FILE}`);
	for (const plan of plans) {
		const tag = plan.candidate ? " (candidate)" : "";
		console.log(
			`  ${plan.kind}${viaTag(plan)}${tag}${plan.skip ? ` — skipped: ${plan.skip}` : ""}`,
		);
	}
	if (live) {
		const noKnob = plans.filter((p) => !p.execLive).map((p) => p.kind);
		if (noKnob.length > 0) {
			console.log(
				`  no live knob: ${noKnob.join(", ")} — cells marked "~" may be cached`,
			);
		}
	}

	const grid = new Map<string, Cell[]>();
	for (const url of urls) {
		console.log(`\n${url}`);
		const cells = await Promise.all(
			plans.map((plan) => runCell(plan, auth, url, live)),
		);
		for (const [i, plan] of plans.entries()) {
			const cell = cells[i];
			if (!cell) continue;
			const row = grid.get(plan.kind) ?? [];
			row.push(cell);
			grid.set(plan.kind, row);
			printCell(plan.kind, cell);
		}
	}

	const labels = urls.map(urlLabel);
	const colW = Math.max(8, ...labels.map((l) => l.length)) + 2;
	console.log("\nsummary");
	console.log(
		`  ${"".padEnd(KIND_W)}${labels.map((l) => l.padEnd(colW)).join("")}score`,
	);
	for (const plan of plans) {
		const cells = grid.get(plan.kind) ?? [];
		const ok = cells.filter(
			(c) => c.outcome === "ok" || c.outcome === "pdf",
		).length;
		// In --live, a no-knob provider's result may be a cache hit —
		// mark it so the row can't be read as a live score.
		const mark =
			live && !plan.execLive
				? (c: Cell) => `${shortOutcome(c)}~`
				: shortOutcome;
		const line = cells.map((c) => mark(c).padEnd(colW)).join("");
		console.log(`  ${plan.kind.padEnd(KIND_W)}${line}${ok}/${cells.length}`);
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
	console.log(`  ${"any".padEnd(KIND_W)}${anyRow}`);

	const recordPath = writeRunRecord({
		schema: 1,
		startedAt,
		mode: live ? "live" : "default",
		urls,
		providers: plans.map((plan) => ({
			kind: plan.kind,
			candidate: plan.candidate,
			via: viaTag(plan) || undefined,
			authName: plan.authName,
			skipped: plan.skip,
			hasLiveKnob: plan.execLive !== undefined,
		})),
		cells: plans.map((plan) => {
			const row = grid.get(plan.kind);
			// runCell always returns one cell per url; the fallback only
			// guards a future code path that stops early.
			if (row && row.length === urls.length) return row;
			return urls.map(
				(): Cell => ({ outcome: "skipped", note: plan.skip }),
			);
		}),
	});
	console.log(`\nrecord: ${recordPath}`);
}

try {
	await main();
} catch (err) {
	console.error("bench failed:", err instanceof Error ? err.message : err);
	process.exit(1);
}
