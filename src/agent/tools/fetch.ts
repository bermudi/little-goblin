// The fetch tool — URL → readable text (DESIGN.md, "Web access").
// Default `local`: direct HTTP + in-process readability extraction
// (linkedom + @mozilla/readability — pure JS, the industry path).
// Provider kinds (jina/tavily/firecrawl/parallel) extract server-side.
// All kinds share the output discipline: a head+tail window cut on line
// boundaries, overflow written to state/webcache/, and a footer naming
// the exact read_file call to page through the middle. No SSRF policy —
// bash already has full network access; the boundary is the tool set.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Config } from "../../config.ts";
import { paths } from "../../config.ts";
import { log } from "../../log.ts";
import { fetchOk, readJson, str, type WebToolDeps } from "./web.ts";

const TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 20_000;
const DOWNLOAD_CAP = 8 * 1024 * 1024;
const DEFAULT_BUDGET = 15_000;
/** Below this the page almost certainly didn't render — say so, name the browser. */
const MIN_EXTRACT = 200;

const BASES = {
	jina: "https://r.jina.ai",
	tavily: "https://api.tavily.com",
	firecrawl: "https://api.firecrawl.dev",
	parallel: "https://api.parallel.ai",
} as const;

type FetchKind = "local" | keyof typeof BASES;

interface Extracted {
	title: string;
	text: string;
}

// ---------- providers ----------

async function postJson(provider: string, url: string, headers: Record<string, string>, body: unknown) {
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

const extractors: Record<Exclude<FetchKind, "local">, (url: string, key: string | undefined, baseUrl?: string) => Promise<Extracted>> = {
	parallel: async (url, key, baseUrl) => {
		const data = (await postJson("parallel", `${baseUrl ?? BASES.parallel}/v1/extract`, key ? { Authorization: `Bearer ${key}` } : {}, {
			urls: [url],
			full_content: true,
		})) as { results?: unknown[]; errors?: unknown[] };
		const row = (data.results ?? [])[0] as Record<string, unknown> | undefined;
		if (!row) {
			const err = (data.errors ?? [])[0] as Record<string, unknown> | undefined;
			throw new Error(
				`parallel: extraction failed — ${str(err?.content) || str(err?.error_type) || "no result"}`,
			);
		}
		const excerpts = Array.isArray(row.excerpts)
			? row.excerpts.filter((e): e is string => typeof e === "string")
			: [];
		return { title: str(row.title), text: str(row.full_content) || excerpts.join("\n\n") };
	},
	tavily: async (url, key, baseUrl) => {
		const data = (await postJson("tavily", `${baseUrl ?? BASES.tavily}/extract`, key ? { Authorization: `Bearer ${key}` } : {}, {
			urls: [url],
			include_images: false,
		})) as { results?: unknown[]; failed_results?: unknown[] };
		const row = (data.results ?? [])[0] as Record<string, unknown> | undefined;
		if (!row) {
			const fail = (data.failed_results ?? [])[0] as Record<string, unknown> | undefined;
			throw new Error(`tavily: extraction failed — ${str(fail?.error) || "no result"}`);
		}
		return { title: str(row.title), text: str(row.raw_content) || str(row.content) };
	},
	firecrawl: async (url, key, baseUrl) => {
		const data = (await postJson("firecrawl", `${baseUrl ?? BASES.firecrawl}/v2/scrape`, key ? { Authorization: `Bearer ${key}` } : {}, {
			url,
			formats: ["markdown"],
		})) as { success?: boolean; error?: string; data?: Record<string, unknown> };
		if (data.success === false || !data.data) {
			throw new Error(`firecrawl: ${str(data.error) || "scrape failed"}`);
		}
		const metadata = data.data.metadata as Record<string, unknown> | undefined;
		return { title: str(metadata?.title), text: str(data.data.markdown) };
	},
	jina: async (url, key, baseUrl) => {
		const res = await fetchOk(
			"jina",
			`${baseUrl ?? BASES.jina}/${url}`,
			{ headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } },
			TIMEOUT_MS,
		);
		const data = (await readJson("jina", res)) as { data?: Record<string, unknown> };
		return { title: str(data.data?.title), text: str(data.data?.content) };
	},
};

// ---------- local ----------

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|toml))/;

async function localExtract(url: string, baseUrl?: string): Promise<Extracted | { error: string; kind: string }> {
	const target = baseUrl ?? url;
	const res = await fetchOk(
		"local",
		target,
		{ headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5" }, redirect: "follow" },
		LOCAL_TIMEOUT_MS,
	);
	const length = Number(res.headers.get("content-length") ?? 0);
	if (length > DOWNLOAD_CAP) {
		return { error: `page is ${Math.round(length / 1024 / 1024)} MiB (cap 8 MiB) — use bash + curl for oversized fetches`, kind: "too-large" };
	}
	const buf = await res.arrayBuffer();
	if (buf.byteLength > DOWNLOAD_CAP) {
		return { error: `page exceeds the 8 MiB download cap — use bash + curl`, kind: "too-large" };
	}
	const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
	const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	const looksHtml = contentType === "text/html" || contentType === "application/xhtml+xml" ||
		(/^\s*<(?:!doctype html|html[\s>])/i.test(body) && contentType === "");
	if (looksHtml) {
		return extractReadable(url, body);
	}
	if (TEXTUAL.test(contentType) || contentType === "") {
		return { title: "", text: body };
	}
	return {
		error: `unsupported content type "${contentType}" (${buf.byteLength} bytes) — fetch it via bash to a file, or send_file to hand it to the operator`,
		kind: "binary",
	};
}

/** HTML → readable text. Pure so the same input materializes identically. */
function extractReadable(url: string, html: string): Extracted | { error: string; kind: string } {
	type ParsedArticle = ReturnType<Readability["parse"]>;
	let article: ParsedArticle = null;
	try {
		const dom = parseHTML(html);
		article = new Readability(dom.document).parse();
	} catch {
		article = null;
	}
	const text = (article?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
	if (text.length < MIN_EXTRACT) {
		return {
			error: `page rendered almost no extractable text (${text.length} chars) — likely a JavaScript shell; use the browser skill (skills/browser) for this site`,
			kind: "empty-extraction",
		};
	}
	return { title: article?.title?.trim() ?? "", text };
}

// ---------- output shaping ----------

export function windowText(text: string, budget: number): { window: string; truncated: boolean } {
	if (text.length <= budget) return { window: text, truncated: false };
	const headBudget = Math.round(budget * 0.75);
	let head = text.slice(0, headBudget);
	const headCut = head.lastIndexOf("\n");
	if (headCut > budget / 2) head = text.slice(0, headCut);
	const tailBudget = budget - head.length;
	let tail = text.slice(text.length - tailBudget);
	const tailCut = tail.indexOf("\n");
	if (tailCut !== -1 && tail.length - tailCut > 0) tail = tail.slice(tailCut + 1);
	return { window: `${head}\n\n[…]\n\n${tail}`, truncated: true };
}

export function shapeResult(url: string, extracted: Extracted, budget: number): string {
	const header = `${extracted.title ? `# ${extracted.title}\n` : ""}Source: ${url}\n\n`;
	const { window, truncated } = windowText(extracted.text, budget);
	if (!truncated) return header + window;
	const file = cachePath(url);
	const full = `${header}${extracted.text}`;
	mkdirSync(paths.webcache(), { recursive: true });
	writeFileSync(file, full);
	return `${header}${window}

[TRUNCATED — full text (${extracted.text.length} chars) saved to: ${file}
read_file with path="${file}" and offset/limit pages through it]`;
}

function cachePath(url: string): string {
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 24);
	return join(paths.webcache(), `${hash}.txt`);
}

// ---------- tool ----------

// Test door: the extractor table, so failure mapping is verifiable
// against a fake server without touching the vendor.
export { extractors };

export const fetchTool = (deps: WebToolDeps) =>
	tool({
		description:
			"Fetch one URL and return readable text (head+tail window of ~15k chars by default; overflow is saved to disk and the footer names the read_file call to page through). Handles plain HTML and text-ish payloads; JavaScript-heavy sites that render nothing should go through the browser skill instead.",
		inputSchema: z.object({
			url: z.string().regex(/^https?:\/\//, "url must be http(s)"),
			maxChars: z.number().int().min(2000).max(50_000).optional(),
		}),
		execute: async (input) => {
			const cfg = deps.configRef.current.fetch;
			const kind: FetchKind = cfg?.kind ?? "local";
			const started = Date.now();
			const budget = input.maxChars ?? DEFAULT_BUDGET;

			let extracted: Extracted | { error: string; kind: string };
			if (kind === "local") {
				extracted = await localExtract(input.url);
			} else {
				const authName = cfg && "auth" in cfg ? cfg.auth : undefined;
				const key = authName ? await deps.auth.resolve(authName) : undefined;
				try {
					extracted = await extractors[kind](input.url, key);
				} catch (err) {
					log.warn("web fetch failed", { url: input.url, kind, error: (err as Error).message });
					throw err;
				}
			}
			if ("error" in extracted) {
				log.warn("web fetch rejected", { url: input.url, kind, reason: extracted.kind });
				return { error: extracted.error, kind: extracted.kind };
			}
			if (extracted.text.trim().length < MIN_EXTRACT) {
				return {
					error: `extraction returned almost no text (${extracted.text.trim().length} chars) — likely a JavaScript shell; use the browser skill (skills/browser)`,
					kind: "empty-extraction",
				};
			}
			const result = shapeResult(input.url, extracted, budget);
			log.info("web fetch", {
				url: input.url,
				kind,
				chars: extracted.text.length,
				truncated: extracted.text.length > budget,
				ms: Date.now() - started,
			});
			return result;
		},
	});
