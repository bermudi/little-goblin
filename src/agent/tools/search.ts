// The search tool — one tool, a provider behind it (DESIGN.md, "Web
// access"). Provider switch is a config edit; the tool's name, schema,
// and result shape never move. Output is deterministic text: numbered
// `title — URL — snippet` lines, every result carrying its URL so fetch
// is the named next step. Wire formats follow hermes' plugins/web
// (brave/tavily verbatim) and the vendors' SDK wire paths (exa
// /search, parallel /v1/search, firecrawl /v2/search, jina s.jina.ai).
// ddg scrapes the unofficial html endpoint — keyless, may rate-limit.

import { tool } from "ai";
import { z } from "zod";
import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";
import { log } from "../../log.ts";
import { fetchOk, readJson, renderHits, str, ProviderError, type SearchHit, type WebToolDeps } from "./web.ts";

const TIMEOUT_MS = 15_000;

// Base URLs are test doors: adapters accept an override, the tool passes
// the default. No config knob — a provider switch is a kind switch.
const BASES = {
	brave: "https://api.search.brave.com",
	exa: "https://api.exa.ai",
	jina: "https://s.jina.ai",
	tavily: "https://api.tavily.com",
	firecrawl: "https://api.firecrawl.dev",
	parallel: "https://api.parallel.ai",
	ddg: "https://html.duckduckgo.com",
} as const;

export type SearchKind = keyof typeof BASES;

interface AdapterOpts {
	query: string;
	count: number;
	key?: string | undefined;
	/** Test door — the production path always uses the default base. */
	baseUrl?: string | undefined;
}

type SearchAdapter = (opts: AdapterOpts) => Promise<SearchHit[]>;

async function getJson(
	provider: string,
	url: string,
	headers: Record<string, string>,
): Promise<unknown> {
	const res = await fetchOk(provider, url, { headers }, TIMEOUT_MS);
	return readJson(provider, res);
}

async function postJson(
	provider: string,
	url: string,
	headers: Record<string, string>,
	body: unknown,
): Promise<unknown> {
	const res = await fetchOk(
		provider,
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		},
		TIMEOUT_MS,
	);
	return readJson(provider, res);
}

function bearer(key?: string): Record<string, string> {
	return key ? { Authorization: `Bearer ${key}` } : {};
}

// ---------- adapters ----------

const braveSearch: SearchAdapter = async (opts) => {
	const base = opts.baseUrl ?? BASES.brave;
	const url = `${base}/res/v1/web/search?q=${encodeURIComponent(opts.query)}&count=${Math.min(opts.count, 20)}`;
	const data = (await getJson("brave", url, {
		Accept: "application/json",
		"X-Subscription-Token": opts.key ?? "",
	})) as { web?: { results?: unknown[] } };
	return (data.web?.results ?? []).slice(0, opts.count).map(toHit("description"));
};

const exaSearch: SearchAdapter = async (opts) => {
	const data = (await postJson(
		"exa",
		`${opts.baseUrl ?? BASES.exa}/search`,
		{ "x-api-key": opts.key ?? "" },
		{ query: opts.query, numResults: opts.count, contents: { highlights: true } },
	)) as { results?: unknown[] };
	return (data.results ?? []).map((r) => {
		const row = r as Record<string, unknown>;
		const highlights = Array.isArray(row.highlights)
			? row.highlights.filter((h): h is string => typeof h === "string")
			: [];
		return { title: str(row.title), url: str(row.url), snippet: highlights.join(" ") };
	});
};

const jinaSearch: SearchAdapter = async (opts) => {
	const url = `${opts.baseUrl ?? BASES.jina}/${encodeURIComponent(opts.query)}`;
	const data = (await getJson("jina", url, { Accept: "application/json", ...bearer(opts.key) })) as {
		data?: unknown[];
	};
	return (Array.isArray(data.data) ? data.data : []).slice(0, opts.count).map(toHit("description"));
};

const tavilySearch: SearchAdapter = async (opts) => {
	const data = (await postJson("tavily", `${opts.baseUrl ?? BASES.tavily}/search`, bearer(opts.key), {
		query: opts.query,
		max_results: opts.count,
		include_raw_content: false,
		include_images: false,
	})) as { results?: unknown[] };
	return (data.results ?? []).map(toHit("content"));
};

const firecrawlSearch: SearchAdapter = async (opts) => {
	const data = (await postJson("firecrawl", `${opts.baseUrl ?? BASES.firecrawl}/v2/search`, bearer(opts.key), {
		query: opts.query,
		limit: opts.count,
	})) as { success?: boolean; search?: unknown[]; error?: string };
	if (data.success === false) {
		throw new ProviderError("firecrawl", str(data.error) || "search failed");
	}
	return (data.search ?? []).map(toHit("description"));
};

const parallelSearch: SearchAdapter = async (opts) => {
	const data = (await postJson("parallel", `${opts.baseUrl ?? BASES.parallel}/v1/search`, bearer(opts.key), {
		search_queries: [opts.query],
		objective: opts.query,
		max_results: opts.count,
	})) as { results?: unknown[] };
	return (data.results ?? []).slice(0, opts.count).map((r) => {
		const row = r as Record<string, unknown>;
		const excerpts = Array.isArray(row.excerpts)
			? row.excerpts.filter((e): e is string => typeof e === "string")
			: [];
		return { title: str(row.title), url: str(row.url), snippet: excerpts.join(" ") };
	});
};

// DuckDuckGo html — the unofficial endpoint. Regex over the stable
// result markup (class=result__a / result__snippet); hrefs ride a
// redirect wrapper carrying the real URL in ?uddg=.
const ddgSearch: SearchAdapter = async (opts) => {
	const res = await fetchOk(
		"ddg",
		`${opts.baseUrl ?? BASES.ddg}/html/`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
			body: `q=${encodeURIComponent(opts.query)}`,
		},
		TIMEOUT_MS,
	);
	const html = await res.text();
	const hits: SearchHit[] = [];
	for (const anchor of html.matchAll(
		/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
	)) {
		const url = unwrapDdgHref(anchor[1] ?? "");
		const title = stripTags(anchor[2] ?? "");
		if (url === "" || title === "") continue;
		hits.push({ title, url, snippet: "" });
		if (hits.length >= opts.count) break;
	}
	// Snippets are optional per result and appear in document order;
	// attach them positionally after the anchors are collected.
	const snippets = [...html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map(
		(m) => stripTags(m[1] ?? ""),
	);
	hits.forEach((hit, i) => {
		hit.snippet = snippets[i] ?? "";
	});
	return hits;
};

/** Mapper for providers whose rows are flat {title,url,<snippetField>}. */
function toHit(snippetField: string) {
	return (row: unknown): SearchHit => {
		const rec = row as Record<string, unknown>;
		return { title: str(rec.title), url: str(rec.url), snippet: str(rec[snippetField]) };
	};
}

function unwrapDdgHref(href: string): string {
	const match = /[?&]uddg=([^&]+)/.exec(href);
	if (match && match[1] !== undefined) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return "";
		}
	}
	return href.startsWith("http") ? href : "";
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const ADAPTERS: Record<SearchKind, SearchAdapter> = {
	brave: braveSearch,
	exa: exaSearch,
	jina: jinaSearch,
	tavily: tavilySearch,
	firecrawl: firecrawlSearch,
	parallel: parallelSearch,
	ddg: ddgSearch,
};

export interface BoundSearch {
	kind: SearchKind;
	run(opts: { query: string; count: number; baseUrl?: string }): Promise<SearchHit[]>;
}

/** Bind a kind + auth ref into a key-carrying adapter. Test door: baseUrl. */
export function bindSearch(
	cfg: { kind: SearchKind; auth?: string | undefined },
	auth: AuthStore,
): (opts: { query: string; count: number; baseUrl?: string | undefined }) => Promise<SearchHit[]> {
	return async (opts) => {
		const key = cfg.auth ? await auth.resolve(cfg.auth) : undefined;
		return ADAPTERS[cfg.kind]({ ...opts, key });
	};
}

export const searchTool = (deps: WebToolDeps) =>
	tool({
		description:
			"Search the web. Returns numbered results (title, URL, snippet) — fetch a result's URL for full content. Express recency in the query itself (\"today\", \"this week\", \"March 2026\"); there are no other knobs.",
		inputSchema: z.object({
			query: z.string().min(1).max(400),
			count: z.number().int().min(1).max(10).default(5),
		}),
		execute: async (input) => {
			const cfg = deps.configRef.current.search;
			if (!cfg) {
				return {
					error: "search is not configured — set a `search` block in goblin.json5",
					kind: "unconfigured",
				};
			}
			const started = Date.now();
			const run = bindSearch(cfg, deps.auth);
			const hits = await run({ query: input.query, count: input.count });
			log.info("web search", {
				provider: cfg.kind,
				query: input.query,
				results: hits.length,
				ms: Date.now() - started,
			});
			return renderHits(hits);
		},
	});
