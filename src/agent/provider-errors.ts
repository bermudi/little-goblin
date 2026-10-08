// Provider-error classification for turn recovery (issue #12). The
// question a classifier answers is "does this failure deserve a
// recovery attempt". Context overflow compacts and resumes; an explicit
// provider content filter gets one unchanged-request retry.

import type { LanguageModelV4Usage } from "@ai-sdk/provider";

// Provider errors arrive deeply wrapped: APICallError carries the HTTP
// status on statusCode and the provider's own body on responseBody, the
// SDK's RetryError nests the real failure under lastError/errors, and
// anything can ride a cause chain. Walk the structure, collect every
// reachable string, and judge the union — guessing which field the
// truth lives in per provider is how classifiers drift false.
const MAX_DEPTH = 4;

interface Collected {
	texts: string[];
	rateLimited: boolean;
	contentFiltered: boolean;
}

function collect(value: unknown, depth: number, seen: Set<object>, out: Collected): void {
	if (value === null || value === undefined || depth > MAX_DEPTH) return;
	if (typeof value === "string") {
		out.texts.push(value);
		return;
	}
	if (typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	const o = value as Record<string, unknown>;
	if (value instanceof ProviderContentFilterError) out.contentFiltered = true;
	if (typeof o.message === "string") out.texts.push(o.message);
	if (o.statusCode === 429) out.rateLimited = true;
	if (typeof o.responseBody === "string") out.texts.push(o.responseBody);
	if (o.data !== undefined) {
		// The SDK attaches the parsed body on `data` for some providers —
		// a JSON.stringify is the only shape-agnostic read of it.
		try {
			const s = JSON.stringify(o.data);
			if (s !== undefined) out.texts.push(s);
		} catch {
			// Unstringifiable data contributes nothing — keep walking.
		}
	}
	collect(o.cause, depth + 1, seen, out);
	collect(o.lastError, depth + 1, seen, out);
	// These two envelopes are accepted by the SDK's stream-error
	// normalizer. Our model adapter sees them before that normalization.
	collect(o.error, depth + 1, seen, out);
	collect(o.response, depth + 1, seen, out);
	if (Array.isArray(o.errors)) {
		for (const e of o.errors) collect(e, depth + 1, seen, out);
	}
}

// Exact provider phrasings, lowercased — the walk's text is folded
// before matching. The test pins each real string to its source; add
// phrasings only with an observed body to back them.
const OVERFLOW_PHRASES = [
	"context_length_exceeded",
	"context_window_exceeded",
	"maximum context length",
	"context length exceeded",
	"prompt is too long",
	"prompt too long",
	"prompt exceeds max length",
	"input is too long",
	"exceeded model token limit",
	"maximum number of input tokens",
	"exceeds the maximum number of tokens",
	"maximum allowed input length",
	"上下文过长",
	"上下文长度",
	"超出最大上下文",
	"上下文超出",
];

const RATE_LIMIT_TEXT = /rate.?limit|per minute|tokens per min|\btpm\b/;
// Providers answer an unsupported-reasoning request with a 400 whose
// wording overlaps overflow phrasing ("maximum") — it is config, not
// context, and compacting behind it would loop forever.
const REASONING_REQUIRED = /reasoning is (mandatory|required)|requires reasoning/;
const CONTEXT_WORDED = /exceed|too long|too large|overflow|ran out of room/;
// z.ai's body code for prompt-too-long (docs.z.ai/api-reference/api-code).
const ZAI_1261 = /"code"\s*:\s*"?1261"?/;

// True when the failure says the request outgrew the model's context
// window — the one failure a compaction can actually fix. Explicitly
// NOT a rate limit (TPM rejections mention "tokens" generously and a
// 429 statusCode is decisive) and not a reasoning-mode rejection.
export function isContextOverflow(err: unknown): boolean {
	const collected: Collected = { texts: [], rateLimited: false, contentFiltered: false };
	collect(err, 0, new Set(), collected);
	const text = collected.texts.join("\n").toLowerCase();
	if (collected.rateLimited) return false;
	if (RATE_LIMIT_TEXT.test(text)) return false;
	if (REASONING_REQUIRED.test(text)) return false;
	for (const phrase of OVERFLOW_PHRASES) {
		if (text.includes(phrase)) return true;
	}
	if (
		(text.includes("context window") || text.includes("context size")) &&
		CONTEXT_WORDED.test(text)
	) {
		return true;
	}
	return ZAI_1261.test(text);
}

// Verbatim warning reported by the operator in Telegram on 2026-10-04.
// The provider's underlying HTTP/SSE envelope is unverified. Match the
// specific warning, not "sensitive", "unsafe", or normal assistant refusals.
const FILTER_WARNING =
	"system detected potentially unsafe or sensitive content in input or generation.";

export class ProviderContentFilterError extends Error {
	constructor(
		cause?: unknown,
		readonly usage?: LanguageModelV4Usage,
	) {
		super("Provider content filter blocked this request.", { cause });
		this.name = "ProviderContentFilterError";
	}
}

export function isContentFilter(err: unknown): boolean {
	if (err instanceof ProviderContentFilterError) return true;
	const collected: Collected = { texts: [], rateLimited: false, contentFiltered: false };
	collect(err, 0, new Set(), collected);
	return (
		collected.contentFiltered ||
		collected.texts.some((text) => text.toLowerCase().includes(FILTER_WARNING))
	);
}
