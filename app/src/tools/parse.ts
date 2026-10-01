// Pure extractors over goblin's tool-wire payloads. The text formats are
// owned by src/agent/tools/web.ts (renderHits / fenceUntrusted) and
// fetch.ts (shapeResult) — mirrored here so the client can render
// structured rows off the verbatim strings history stores. Everything is
// tolerant: unexpected input yields null/empty and the caller falls
// back, never a throw.

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResult {
	hits: SearchHit[];
	/** The "(via <kind> — <why>)" fallback note when the chain served it. */
	note: string | null;
}

// fenceUntrusted neutralizes "</web" inside remote text as "<\/web" —
// restore it for display.
function unescapeFence(text: string): string {
	return text.replace(/<\\\/web/g, "</web");
}

// renderHits emits "N. title — URL" lines inside the <web> fence, the
// snippet indented three spaces on the following line. The URL rides
// last so a title containing " — " still parses off the final separator.
export function parseSearchOutput(text: string): SearchResult | null {
	const trimmed = text.trim();
	if (trimmed === "No results.") return { hits: [], note: null };
	const fence = /^<web>\n([\s\S]*?)\n<\/web>\n?([\s\S]*)$/.exec(trimmed);
	if (fence === null) return null;
	const hits: SearchHit[] = [];
	for (const line of (fence[1] ?? "").split("\n")) {
		const head = /^\d+\.\s+(.+)$/.exec(line);
		if (head !== null) {
			const body = head[1] ?? "";
			const sep = body.lastIndexOf(" — ");
			hits.push(
				sep === -1
					? { title: unescapeFence(body), url: "", snippet: "" }
					: {
							title: unescapeFence(body.slice(0, sep)),
							url: body.slice(sep + 3),
							snippet: "",
						},
			);
			continue;
		}
		const last = hits.at(-1);
		if (last !== undefined && /^\s+\S/.test(line)) {
			const cont = unescapeFence(line.trim());
			last.snippet = last.snippet === "" ? cont : `${last.snippet} ${cont}`;
		}
	}
	// The tail is the standing fence note plus an optional fallback line;
	// only the "(via …)" part is worth a row.
	const via = /\(via [^\n]*\)/.exec(fence[2] ?? "");
	return { hits, note: via === null ? null : via[0] };
}

export interface FetchText {
	source: string | null;
	title: string | null;
	/** The extracted page text (fence stripped), or the raw string. */
	body: string;
	chars: number;
	truncated: boolean;
}

// shapeResult emits "Source: <url>" then the <web> fence whose first
// line is the page's "# title"; overflow adds a [TRUNCATED — …] footer.
export function parseFetchText(text: string): FetchText {
	const source = /^Source: (\S+)/.exec(text)?.[1] ?? null;
	const fenced = /<web>\n([\s\S]*?)\n<\/web>/.exec(text)?.[1];
	const body = fenced === undefined ? text : unescapeFence(fenced);
	const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? null;
	return { source, title, body, chars: body.length, truncated: /\[TRUNCATED —/.test(text) };
}

export function hostOf(url: string | null): string {
	if (url === null) return "";
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export function countLines(text: string): number {
	return text === "" ? 0 : text.split("\n").length;
}

export function clipHead(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[… ${text.length - max} more chars]`;
}

export function clipTail(text: string, max: number): string {
	if (text.length <= max) return text;
	return `[… ${text.length - max} earlier chars]\n${text.slice(text.length - max)}`;
}

export function firstLine(text: string, max = 72): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtChars(n: number): string {
	return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;
}

export function byteLen(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** Join the fragments of a collapsed-row summary, skipping empties. */
export function joinSummary(...parts: (string | null | undefined)[]): string {
	return parts
		.filter((p): p is string => typeof p === "string" && p !== "")
		.join(" · ");
}

function scalar(v: unknown): string | null {
	if (typeof v === "string") {
		const s = v.trim();
		return s === "" ? null : firstLine(s, 80);
	}
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	if (Array.isArray(v)) {
		for (const e of v) {
			const s = scalar(e);
			if (s !== null) return s;
		}
	}
	return null;
}

// Best-effort one-liner for tools with no bespoke renderer: the first
// scalar under a well-known key, most descriptive first.
const HINT_KEYS = [
	"command",
	"url",
	"query",
	"path",
	"file",
	"to",
	"subject",
	"conversation",
	"id",
	"name",
	"action",
	"text",
] as const;

export function inputSummary(input: unknown): string | null {
	if (typeof input !== "object" || input === null) return null;
	const rec = input as Record<string, unknown>;
	for (const k of HINT_KEYS) {
		const s = scalar(rec[k]);
		if (s !== null) return s;
	}
	return null;
}

// Same trick on the output side, for the collapsed row of generic tools
// whose input carried no hint.
const OUT_KEYS = ["status", "sent", "queued", "stopped", "replaced", "bytes", "id", "name"] as const;

export function outputSummary(output: unknown): string | null {
	if (typeof output !== "object" || output === null) return null;
	const rec = output as Record<string, unknown>;
	for (const k of OUT_KEYS) {
		const v = rec[k];
		const s = scalar(v);
		if (s !== null) return k === "status" || k === "id" || k === "name" ? s : `${k} ${s}`;
	}
	return null;
}

/** Compact JSON for the generic detail panes — capped, never throwing. */
export function shortJson(value: unknown, max = 4000): string {
	let s: string;
	try {
		s = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
	} catch {
		s = "(unprintable)";
	}
	return clipHead(s === "" ? "(empty)" : s, max);
}
