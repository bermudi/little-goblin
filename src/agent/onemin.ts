// 1min.AI's OpenAI-compatible relay (base URL
// https://api.1min.ai/openai/v1 — the Chat Completions door of
// docs.1min.ai/docs/api/openai-compatible). The operator-supplied
// provider docs pin pipe truths the generic openai-compatible path
// must not guess; this module is their one home, mirroring the
// z.ai precedent (zai-responses.ts owns api.z.ai quirks the same
// way).
//
// What the docs establish, and why each rule exists:
// - Every POST /chat/completions is a new generation billed on the
//   account ("retrying a POST is a new generation and may incur
//   another charge"; "Automatic retries are disabled upstream. Set
//   maxRetries: 0 in your client too") — the SDK's default retry
//   (2 attempts with backoff) would be a silent double charge.
// - All models accept text only, "including models with vl in their
//   names" — the endpoint rejects image/audio input outright, so no
//   media rides this pipe regardless of what a catalog lists for the
//   model id (models.dev under the serving provider would say
//   qwen3-vl-plus sees images; through this relay it does not).
// - streaming reports usage only under
//   stream_options.include_usage, which the relay supports — without
//   it every usage log line is null and the model-call ledger
//   (DESIGN.md → "the log must reconstruct what the process did")
//   goes blind.

import { splitModelRef, type Config } from "../config.ts";

/** The docs page the relay truths here are pinned to. */
export const ONEMIN_DOCS_URL = "https://docs.1min.ai/docs/api/openai-compatible";

/** True when an OpenAI-compatible baseUrl points at 1min's relay. */
export function isOneMinHost(baseUrl: string | undefined): boolean {
	if (baseUrl === undefined) return false;
	try {
		return new URL(baseUrl).hostname === "api.1min.ai";
	} catch {
		// A malformed baseUrl fails at the config boundary; here it
		// just means "not this relay".
		return false;
	}
}

/** True when a "<provider>/<model-id>" ref resolves onto 1min's relay. */
export function isOneMinRoute(config: Pick<Config, "providers">, modelRef: string): boolean {
	const { provider } = splitModelRef(modelRef);
	const p = config.providers[provider];
	return p !== undefined && "baseUrl" in p && isOneMinHost(p.baseUrl);
}

/**
 * The retry budget for one chat call: 0 on 1min (each attempt bills),
 * undefined elsewhere — undefined keeps the SDK default so unrelated
 * providers never change behavior.
 */
export function modelCallMaxRetries(
	config: Pick<Config, "providers">,
	modelRef: string,
): number | undefined {
	return isOneMinRoute(config, modelRef) ? 0 : undefined;
}
