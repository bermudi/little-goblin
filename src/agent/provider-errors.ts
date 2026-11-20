// "Does this failure deserve a recovery attempt": context overflow
// compacts and resumes; a provider content filter gets one
// unchanged-request retry.

import type { Usage } from "../message.ts";

// The one failure shape sorting reads (design/model.md → Provider
// failure shape, #770). Each engine builds it at its own edge — the AI
// SDK's errors in sdk-errors.ts, the Claude Code CLI's result frames in
// claude-code/engine.ts — so no vendor field name reaches this file.
export type ProviderVerdict = "quota" | "transient";

export interface ProviderFacts {
	/** The HTTP status the provider answered with. */
	readonly status?: number | undefined;
	/** The provider's error body or payload, as text. */
	readonly body?: string | undefined;
	/** A verdict the vendor typed as an error code, not prose. */
	readonly verdict?: ProviderVerdict | undefined;
}

export class ProviderError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	readonly verdict: ProviderVerdict | undefined;
	constructor(message: string, facts: ProviderFacts, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ProviderError";
		this.status = facts.status;
		this.body = facts.body;
		this.verdict = facts.verdict;
	}
}

// Errors arrive wrapped: goblin rails nest the engine's ProviderError
// under a cause, a retry ladder aggregates its attempts. Judge the union
// of every reachable string — guessing which field the truth lives in
// per provider is how classifiers drift false. The walk reads goblin's
// shape and standard JS errors (message, cause, AggregateError) only.
const MAX_DEPTH = 4;

interface Collected {
	texts: string[];
	rateLimited: boolean;
	contentFiltered: boolean;
	// A quota wall the provider stated in structure, not prose: a typed
	// verdict, or HTTP 402 Payment Required (OpenRouter's insufficient
	// credits; Brave search's observed 402 "Usage limit exceeded.").
	quotaWall: boolean;
	transientVerdict: boolean;
	statuses: number[];
}

function collect(value: unknown, depth: number, seen: Set<object>, out: Collected): void {
	if (value === null || value === undefined || depth > MAX_DEPTH) return;
	if (typeof value === "string") {
		out.texts.push(value);
		return;
	}
	if (!(value instanceof Error)) return;
	if (seen.has(value)) return;
	seen.add(value);
	if (value instanceof ProviderContentFilterError) out.contentFiltered = true;
	out.texts.push(value.message);
	if (value instanceof ProviderError) {
		if (value.status !== undefined) out.statuses.push(value.status);
		if (value.status === 429) out.rateLimited = true;
		if (value.status === 402 || value.verdict === "quota") out.quotaWall = true;
		if (value.verdict === "transient") out.transientVerdict = true;
		if (value.body !== undefined) out.texts.push(value.body);
	}
	collect(value.cause, depth + 1, seen, out);
	if (value instanceof AggregateError) {
		for (const e of value.errors) collect(e, depth + 1, seen, out);
	}
}

function collectAll(err: unknown): Collected {
	const collected: Collected = {
		texts: [],
		rateLimited: false,
		contentFiltered: false,
		quotaWall: false,
		transientVerdict: false,
		statuses: [],
	};
	collect(err, 0, new Set(), collected);
	return collected;
}

// Exact provider phrasings, lowercased — the walk's text is folded
// before matching. Add phrasings only with an observed body to back them.
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

// Shared verbatim with isTransientTurnFailure — the retry ladder's
// overflow exclusion must never drift from this classifier.
function overflowByPhrases(text: string): boolean {
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

// The one failure a compaction can actually fix. Explicitly NOT a rate
// limit — TPM rejections mention "tokens" generously; a 429 status
// is decisive — not a structural quota wall, and not a reasoning-mode
// rejection.
export function isContextOverflow(err: unknown): boolean {
	const collected = collectAll(err);
	const text = collected.texts.join("\n").toLowerCase();
	if (collected.rateLimited || collected.quotaWall) return false;
	if (RATE_LIMIT_TEXT.test(text)) return false;
	return overflowByPhrases(text);
}

// Verbatim warning reported by the operator 2026-10-04; the provider's
// underlying HTTP/SSE envelope is unverified. Match the specific
// warning — not "sensitive", "unsafe", or normal assistant refusals.
const FILTER_WARNING =
	"system detected potentially unsafe or sensitive content in input or generation.";

export class ProviderContentFilterError extends Error {
	constructor(
		cause?: unknown,
		readonly usage?: Usage,
	) {
		super("Provider content filter blocked this request.", { cause });
		this.name = "ProviderContentFilterError";
	}
}

// Shared verbatim with isTransientTurnFailure — a recognized warning
// riding a 5xx must never classify both filtered and transient.
function contentFilterDetected(collected: Collected): boolean {
	return (
		collected.contentFiltered ||
		collected.texts.some((text) => text.toLowerCase().includes(FILTER_WARNING))
	);
}

export function isContentFilter(err: unknown): boolean {
	if (err instanceof ProviderContentFilterError) return true;
	return contentFilterDetected(collectAll(err));
}

// Transient means exactly that: a retry with nothing spent can
// succeed. Spend-bearing failures (any completed model work) are
// excluded upstream by the caller's zero-completed-calls gate; any
// model output at all disqualifies the retry at the sink.
const TRANSIENT_PHRASES = [
	"econnrefused",
	"econnreset",
	"enotfound",
	"etimedout",
	"eai_again",
	"epipe",
	"und_err",
	"socket hang up",
	"fetch failed",
	"other side closed",
	"premature close",
	"network connection lost",
	// Codex reports overload in-stream (HTTP 200, then `response.failed`),
	// so no 5xx status reaches the status check below. Observed body
	// (goblin.log 2026-10-26T01:52:51Z): {"type":"service_unavailable_error",
	// "code":"server_is_overloaded","message":"Our servers are currently
	// overloaded. Please try again later."} — anchored on the stable code.
	"server_is_overloaded",
];

// Quota exhaustion is a wall measured in days, not a throttle: a retry
// ladder of seconds cannot cross it. Phrasings are anchored — an
// unanchored "limit exhausted" matched throttle prose like "rate limit
// exhausted", and the quota verdict outranks rate-limit evidence here
// and in isTransientTurnFailure, so a throttled 429 would lose its SDK
// retries to quotaNoRetry. Observed bodies: z.ai HTTP 429 "Weekly/Monthly
// Limit Exhausted. Your limit will reset at 2026-10-28 08:50:34"
// (goblin.log 2026-10-26 — matched through the "monthly" half; the
// "weekly" half pins the compound's other edge) and Brave search HTTP 402
// "Usage limit exceeded." z.ai's balance-exhausted body ("429 code 1113
// Insufficient balance") is recorded in design/memory.md. One deliberate exception to the observed-body rule:
// OpenAI's stable documented error code "insufficient_quota" — the codex
// and OpenAI-compatible doors flow through the same middleware, and the
// flattened data JSON reaches the matched text.
const QUOTA_PHRASES = [
	"weekly limit exhausted",
	"monthly limit exhausted",
	"usage limit exceeded",
	"insufficient balance",
	"insufficient_quota",
];

function quotaByPhrases(text: string): boolean {
	return QUOTA_PHRASES.some((p) => text.includes(p));
}
const QUOTA_RESET = /will reset at (\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}:\d{2})/;

export interface QuotaExhausted {
	// The provider's stated reset, verbatim — it carries no timezone.
	resetAt?: string;
}

// Quota wins over the 429 status that usually carries it.
export function quotaExhausted(err: unknown): QuotaExhausted | null {
	const collected = collectAll(err);
	const text = collected.texts.join("\n").toLowerCase();
	if (!collected.quotaWall && !quotaByPhrases(text)) return null;
	const resetAt = QUOTA_RESET.exec(text)?.[1];
	return resetAt === undefined ? {} : { resetAt };
}

// Availability-class only. Content filters and context overflows are
// verdicts about the request, not the provider's availability —
// retrying them unchanged cannot help, so they read false even when a
// status code might otherwise say transient.
export function isTransientTurnFailure(err: unknown): boolean {
	const collected = collectAll(err);
	if (contentFilterDetected(collected)) return false;
	const text = collected.texts.join("\n").toLowerCase();
	if (collected.quotaWall || quotaByPhrases(text)) return false;
	// Rate-limit evidence decides first — isContextOverflow's order in
	// mirror, so a throttled rejection carrying overflow-ish body prose
	// can't read as neither transient nor compactable.
	if (collected.rateLimited) return true;
	if (RATE_LIMIT_TEXT.test(text)) return true;
	if (overflowByPhrases(text)) return false;
	for (const status of collected.statuses) {
		if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
	}
	if (collected.transientVerdict) return true;
	for (const phrase of TRANSIENT_PHRASES) {
		if (text.includes(phrase)) return true;
	}
	// undici's terminate error is the bare word "terminated" — matched as
	// a whole message so provider prose merely using the word stays out.
	if (collected.texts.some((t) => t.trim().toLowerCase() === "terminated")) return true;
	return false;
}
