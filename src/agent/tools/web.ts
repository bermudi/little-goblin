// Shared plumbing for the web tools (DESIGN.md, "Web access"). The
// provider adapters live in search.ts / fetch.ts; this module owns the
// fail-loud HTTP helper, the capped body reads, the normalized result
// shape, the bounded deterministic rendering both tools share, and the
// untrusted-content fence every remotely controlled text rides in.
// Error paths carry status to the model; remote error bodies are logged
// separately, never mixed into trusted tool framing.

import { log } from "../../log.ts";
import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";
import type { AcceptsMedia } from "../attachments.ts";

/** Shared deps for the web tools: live config + the secrets store.
 *  `accepts` is the per-turn media-acceptance ref (see attachments.ts) —
 *  filled by the runtime after buildStep resolves the model, read at
 *  request time when the fetch tool renders a stored PDF reference.
 *  Absent = nothing rides natively; everything degrades to text. */
export interface WebToolDeps {
	configRef: { current: Config };
	auth: AuthStore;
	accepts?: { current: AcceptsMedia };
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
/** Error bodies feed only BODY_HEAD chars of message — an endless
 *  error page must not be buffered whole for them. */
const ERROR_BODY_CAP = 64 * 1024;
/** JSON can carry a whole page inside it (extract providers do) — the
 *  same 8 MiB ceiling fetch enforces on downloads. */
const JSON_CAP = 8 * 1024 * 1024;

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
		let text = "";
		try {
			({ text } = await readTextCapped(res, ERROR_BODY_CAP));
		} catch {
			// An error body that cannot be read must not mask the status.
			text = "";
		}
		const body = text.replace(/\s+/g, " ").trim();
		log.warn("web provider HTTP error", {
			provider,
			status: res.status,
			bodyHead: body.slice(0, BODY_HEAD),
		});
		throw new ProviderError(provider, `HTTP ${res.status}`);
	}
	return res;
}

/** Wire metadata for one provider response — the web tools' log fields. */
export interface HttpMeta {
	status: number;
	contentType: string;
	bytes: number;
}

/** Boundary metadata off a response; bytes filled in once the body is read. */
export function resMeta(res: Response, bytes = 0): HttpMeta {
	return {
		status: res.status,
		contentType: (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
		bytes,
	};
}

/** The cap is a ceiling on reads, not a post-hoc check (fetch.ts's
 *  readBodyCapped rule): the stream is cancelled the moment the cap
 *  trips, and only a stream that ends within it is assembled whole. A
 *  too-large read returns what it saw — enough for an error head,
 *  never a claim the body was read to its end. */
export async function readTextCapped(
	res: Response,
	cap: number,
): Promise<{ tooLarge: boolean; text: string }> {
	if (res.body === null) {
		// No stream to gate (not reachable for http(s) fetch today) —
		// there is nothing to stream-cancel either.
		const text = await res.text();
		return { tooLarge: Buffer.byteLength(text) > cap, text };
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let seen = 0;
	let tooLarge = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		chunks.push(value);
		seen += value.byteLength;
		if (seen > cap) {
			tooLarge = true;
			await reader.cancel();
			break;
		}
	}
	const bytes = new Uint8Array(seen);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return { tooLarge, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

/** Parse a JSON body (with its byte size) or fail with the provider's
 *  name. The read is capped — a provider response is attacker-sized
 *  until proven otherwise. */
export async function readJson(
	provider: string,
	res: Response,
): Promise<{ data: unknown; bytes: number }> {
	const { tooLarge, text } = await readTextCapped(res, JSON_CAP);
	if (tooLarge) {
		throw new ProviderError(
			provider,
			`response exceeds the ${JSON_CAP / 1024 / 1024} MiB read cap`,
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(text) as unknown;
	} catch (err) {
		throw new ProviderError(provider, `non-JSON response — ${(err as Error).message}`);
	}
	return { data, bytes: Buffer.byteLength(text) };
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

/** The one fence for remotely controlled text entering model context
 *  (the mail/event rule, DESIGN.md "Web access" / "Email"): any
 *  `</tag` in the body is neutralized (case-insensitive) so a payload
 *  cannot close its own fence early, and the caller's standing note
 *  rides after the close. Trusted framing — fetch's title/Source
 *  header and recovery footer, search's fallback note — stays outside
 *  so the payload can never quote or displace it. */
export function fenceUntrusted(tag: string, note: string, body: string): string {
	const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const safe = body.replace(new RegExp(`</${esc}`, "gi"), `<\\/${esc}`);
	return `<${tag}>\n${safe}\n</${tag}>\n${note}`;
}
