import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";
import { log } from "../../log.ts";
import type { AcceptsMedia } from "../attachments.ts";

export interface WebToolDeps {
	configRef: { current: Config };
	auth: AuthStore;
	accepts?: { current: AcceptsMedia };
}

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

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
const ERROR_BODY_CAP = 64 * 1024;
const JSON_CAP = 8 * 1024 * 1024;

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
			// A swallowed error body must not mask the HTTP status.
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

export interface HttpMeta {
	status: number;
	contentType: string;
	bytes: number;
}

export function resMeta(res: Response, bytes = 0): HttpMeta {
	return {
		status: res.status,
		contentType: (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
		bytes,
	};
}

export async function readBytesCapped(
	res: Response,
	cap: number,
): Promise<{ tooLarge: boolean; bytes: Uint8Array }> {
	if (res.body === null) {
		const bytes = new Uint8Array(await res.arrayBuffer());
		return { tooLarge: bytes.byteLength > cap, bytes };
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
	return { tooLarge, bytes };
}

export async function readTextCapped(
	res: Response,
	cap: number,
): Promise<{ tooLarge: boolean; text: string }> {
	const { tooLarge, bytes } = await readBytesCapped(res, cap);
	return { tooLarge, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

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

export function clampChars(text: string, max: number): string {
	const chars = [...text.trim()];
	return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

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

export function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function fenceUntrusted(tag: string, note: string, body: string): string {
	const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const safe = body.replace(new RegExp(`</${esc}`, "gi"), `<\\/${esc}`);
	return `<${tag}>\n${safe}\n</${tag}>\n${note}`;
}
