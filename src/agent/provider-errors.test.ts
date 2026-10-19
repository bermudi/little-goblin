import { describe, expect, test } from "bun:test";
import { RetryError } from "ai";
import { APICallError } from "@ai-sdk/provider";
import {
	isContentFilter,
	isContextOverflow,
	isTransientTurnFailure,
	ProviderContentFilterError,
} from "./provider-errors.ts";

// Every positive pins a real provider string to its source. None were
// observed by goblin itself — the z.ai code is documented at
// docs.z.ai/api-reference/api-code; the rest come from the
// openclaw/hermes field corpora.

describe("isContextOverflow — positives", () => {
	test("z.ai body code 1261 (documented at docs.z.ai/api-reference/api-code)", () => {
		const err = new APICallError({
			message: "Bad Request",
			url: "https://api.z.ai/api/v1/responses",
			requestBodyValues: {},
			statusCode: 400,
			responseBody: `{"error":{"code":"1261","message":"Prompt too long"}}`,
		});
		expect(isContextOverflow(err)).toBe(true);
	});

	test("OpenAI chat completions (field corpus, not observed by goblin)", () => {
		expect(
			isContextOverflow(
				new Error(
					"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
				),
			),
		).toBe(true);
	});

	test("OpenAI Responses (field corpus, not observed by goblin)", () => {
		expect(
			isContextOverflow(new Error("Your input exceeds the context window of this model.")),
		).toBe(true);
	});

	test("OpenRouter (field corpus, not observed by goblin)", () => {
		expect(
			isContextOverflow(
				new Error(
					"This endpoint's maximum context length is 202752 tokens. However, you requested about 250000 tokens",
				),
			),
		).toBe(true);
	});

	test("Anthropic (field corpus, not observed by goblin)", () => {
		expect(isContextOverflow(new Error("prompt is too long: 208423 tokens > 200000 maximum"))).toBe(
			true,
		);
	});

	test("Kimi (field corpus, not observed by goblin)", () => {
		expect(
			isContextOverflow(
				new Error(
					"Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
				),
			),
		).toBe(true);
	});

	test("the truth hiding only in responseBody still classifies", () => {
		const err = new APICallError({
			message: "Bad Request",
			url: "https://api.openai.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 400,
			responseBody: `{"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}`,
		});
		expect(isContextOverflow(err)).toBe(true);
	});

	test("the truth nested under a RetryError's lastError still classifies", () => {
		const err = new RetryError({
			message: "Failed after 3 attempts",
			reason: "maxRetriesExceeded",
			errors: [
				new Error("socket hangup"),
				new APICallError({
					message: "prompt is too long: 208423 tokens > 200000 maximum",
					url: "https://api.anthropic.com/v1/messages",
					requestBodyValues: {},
					statusCode: 400,
				}),
			],
		});
		expect(isContextOverflow(err)).toBe(true);
	});
});

describe("isContextOverflow — negatives", () => {
	test("a 429 TPM rejection is a rate limit, not overflow", () => {
		const err = new APICallError({
			message: "Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 50000",
			url: "https://api.openai.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 429,
		});
		expect(isContextOverflow(err)).toBe(false);
	});

	test("z.ai 1302 rate limit is not overflow", () => {
		expect(
			isContextOverflow(
				new Error(`{"error":{"code":"1302","message":"Rate limit reached for requests"}}`),
			),
		).toBe(false);
	});

	test("z.ai 1113 insufficient balance is not overflow", () => {
		expect(
			isContextOverflow(
				new Error(
					`{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}`,
				),
			),
		).toBe(false);
	});

	test("a reasoning-mode rejection is config, not context", () => {
		expect(
			isContextOverflow(
				new Error("reasoning is mandatory for this endpoint and cannot be disabled"),
			),
		).toBe(false);
	});

	test("an auth failure is not overflow", () => {
		expect(isContextOverflow(new Error("Authentication Failed"))).toBe(false);
	});

	test("a bare 400 with no overflow wording is not overflow", () => {
		expect(isContextOverflow(new Error("Bad Request"))).toBe(false);
	});

	test("null and undefined are not overflow", () => {
		expect(isContextOverflow(undefined)).toBe(false);
		expect(isContextOverflow(null)).toBe(false);
	});
});

describe("isContentFilter", () => {
	// Operator's pasted Telegram warning; the HTTP/SSE envelope is unverified.
	const warning =
		"[System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation.][20261005061517b57fc824";

	test("recognizes the reported warning through SDK error wrapping", () => {
		expect(isContentFilter(new Error(warning))).toBe(true);
		expect(isContentFilter({ cause: { responseBody: warning } })).toBe(true);
		expect(isContentFilter({ error: { message: warning } })).toBe(true);
		expect(isContentFilter({ response: { error: { message: warning } } })).toBe(true);
		expect(isContentFilter(new ProviderContentFilterError())).toBe(true);
		expect(isContentFilter(new Error("wrapped", { cause: new ProviderContentFilterError() }))).toBe(
			true,
		);
	});

	test("does not guess from generic refusals, status codes, or sensitive words", () => {
		for (const error of [
			new Error("I cannot help with that request."),
			new Error("Potentially sensitive content"),
			{ statusCode: 400, message: "Bad Request" },
			{ statusCode: 403, message: "Forbidden" },
			new Error("socket hangup"),
			null,
		])
			expect(isContentFilter(error)).toBe(false);
	});
});

// Wrapped the way Node and undici actually nest them — none observed
// by goblin; these are the node/undici error codes and fetch failure
// surfaces a provider call can die on.
describe("isTransientTurnFailure", () => {
	test.each([
		["econnrefused", new Error("connect ECONNREFUSED 127.0.0.1:443")],
		["econnreset", new Error("request failed", { cause: new Error("read ECONNRESET") })],
		["enotfound", new Error("getaddrinfo ENOTFOUND api.example.com")],
		["etimedout", new Error("connect ETIMEDOUT 1.2.3.4:443")],
		["eai_again", new Error("getaddrinfo EAI_AGAIN api.example.com")],
		["epipe", new Error("write EPIPE")],
		["und_err", new Error("UND_ERR_CONNECT_TIMEOUT")],
		["socket hang up", new Error("socket hang up")],
		["fetch failed", new Error("fetch failed")],
		["terminated", new TypeError("terminated")],
		["other side closed", new Error("other side closed")],
		["premature close", new Error("premature close")],
		[
			"network connection lost",
			new Error("fetch failed", {
				cause: new Error("network connection lost through proxy"),
			}),
		],
	])("a %s phrase classifies transient, even nested in a cause chain", (_family, err) => {
		expect(isTransientTurnFailure(err)).toBe(true);
	});

	test.each([408, 425, 429, 500, 502, 503, 529])(
		"a %i statusCode classifies transient",
		(status) => {
			const at = (code: number) =>
				new APICallError({
					message: "request failed",
					url: "https://api.example.com/v1/chat/completions",
					requestBodyValues: {},
					statusCode: code,
				});
			expect(isTransientTurnFailure(at(status))).toBe(true);
			expect(isTransientTurnFailure(new Error("request failed", { cause: at(status) }))).toBe(true);
		},
	);

	test("the truth hiding under a RetryError's errors still classifies", () => {
		const err = new RetryError({
			message: "Failed after 3 attempts",
			reason: "maxRetriesExceeded",
			errors: [
				new APICallError({
					message: "Bad Gateway",
					url: "https://api.example.com/v1/chat/completions",
					requestBodyValues: {},
					statusCode: 502,
				}),
			],
		});
		expect(isTransientTurnFailure(err)).toBe(true);
	});

	test("a content filter is a verdict, not an outage — even over a 503", () => {
		expect(isTransientTurnFailure(new ProviderContentFilterError())).toBe(false);
		expect(
			isTransientTurnFailure(
				new Error("request failed", {
					cause: new ProviderContentFilterError(
						new APICallError({
							message: "Service Unavailable",
							url: "https://api.example.com",
							requestBodyValues: {},
							statusCode: 503,
						}),
					),
				}),
			),
		).toBe(false);
		expect(
			isTransientTurnFailure(
				new Error(
					"[System detected potentially unsafe or sensitive content in input or generation.]",
				),
			),
		).toBe(false);
		// The warning text riding a 5xx: isContentFilter's recognition is
		// the verdict — the status code alone must not route it onto the
		// transient retry ladder.
		const wrapped = new APICallError({
			message: "Service Unavailable",
			url: "https://api.example.com",
			requestBodyValues: {},
			statusCode: 503,
			responseBody:
				"[System detected potentially unsafe or sensitive content in input or generation.]",
		});
		expect(isContentFilter(wrapped)).toBe(true);
		expect(isTransientTurnFailure(wrapped)).toBe(false);
	});

	test("an overflow is a lost cause on retry — even over a 5xx", () => {
		expect(isTransientTurnFailure(new Error("prompt is too long: 208423 tokens"))).toBe(false);
		expect(
			isTransientTurnFailure(
				new APICallError({
					message: "prompt is too long: 208423 tokens > 200000 maximum",
					url: "https://api.anthropic.com/v1/messages",
					requestBodyValues: {},
					statusCode: 500,
				}),
			),
		).toBe(false);
	});

	test("a throttled error carrying overflow prose is transient, not neither", () => {
		// The z.ai-1261-on-429 shape: rate-limit evidence is decisive in
		// both classifiers, so the same error can't be neither retried
		// nor compacted.
		const err = new APICallError({
			message: "prompt is too long",
			url: "https://api.example.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 429,
		});
		expect(isContextOverflow(err)).toBe(false);
		expect(isTransientTurnFailure(err)).toBe(true);
	});

	test("a rate limit riding only message text is still transient", () => {
		expect(isTransientTurnFailure(new Error("Rate limit reached for requests"))).toBe(true);
	});

	test("prose merely using the word terminated is not a broken connection", () => {
		expect(
			isTransientTurnFailure(new Error("your deployment was terminated for policy violations")),
		).toBe(false);
	});

	test("non-transient statuses and plain errors are not retryable", () => {
		expect(
			isTransientTurnFailure(
				new APICallError({
					message: "Authentication Failed",
					url: "https://api.example.com",
					requestBodyValues: {},
					statusCode: 401,
				}),
			),
		).toBe(false);
		expect(isTransientTurnFailure(new Error("Authentication Failed"))).toBe(false);
		expect(isTransientTurnFailure(undefined)).toBe(false);
		expect(isTransientTurnFailure(null)).toBe(false);
	});
});
