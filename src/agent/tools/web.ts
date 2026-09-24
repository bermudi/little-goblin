// Shared plumbing for the web tools (DESIGN.md, "Web access"). The
// provider adapters live in search.ts / fetch.ts; this module owns the
// fail-loud HTTP helper, the normalized result shape, and the bounded
// deterministic rendering both tools share. Error paths carry status and
// a body head — never request headers, so credentials cannot leak into
// an error message, a log line, or the model context.

import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";

/** Shared deps for the web tools: live config + the secrets store. */
export interface WebToolDeps {
	configRef: { current: Config };
	auth: AuthStore;
}

/** A normalized search result — everything else provider-specific is dropped. */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Transport/HTTP failure at a provider boundary. Message is model-safe. */
export class ProviderError extends Error {
	constructor(
		public readonly provider: string,
		message: string,
	) {
		super(`${provider}: ${message}`);
		this.name = "ProviderError";
	}
}

const BODY_HEAD = 300;

/** fetch() with a timeout; network failures become ProviderError. */
export async function fetchOk(
	provider: string,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		throw new ProviderError(provider, `request failed — ${(err as Error).message}`);
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
		throw new ProviderError(
			provider,
			`HTTP ${res.status}${body ? ` — ${body.slice(0, BODY_HEAD)}` : ""}`,
		);
	}
	return res;
}

/** Parse a JSON response body or fail with the provider's name and status. */
export async function readJson(provider: string, res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch (err) {
		throw new ProviderError(provider, `non-JSON response — ${(err as Error).message}`);
	}
}

/** UTF-8-safe character clamp for titles and snippets. */
export function clampChars(text: string, max: number): string {
	const chars = [...text.trim()];
	return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** Deterministic numbered rendering: `N. title — URL` + indented snippet. */
export function renderHits(hits: SearchHit[]): string {
	if (hits.length === 0) return "No results.";
	return hits
		.map((hit, i) => {
			const snippet = clampChars(hit.snippet.replace(/\s+/g, " "), 300);
			const line = `${i + 1}. ${clampChars(hit.title, 200)} — ${hit.url}`;
			return snippet === "" ? line : `${line}\n   ${snippet}`;
		})
		.join("\n");
}

/** Coerce a provider field to a trimmed string, tolerating null/missing. */
export function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
