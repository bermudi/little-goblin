// Knows nothing about Telegram beyond the 128-char topic-name cap —
// the caller owns the editForumTopic boundary.

import { generateText, type LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AuthStore } from "../auth.ts";
import type { CacheObservation } from "../cache-observation.ts";
import type { ConfigRef } from "../config.ts";
import { log } from "../log.ts";
import { cacheRouteFor, observedModel, resolveModel } from "./providers.ts";
import { modelCallMaxRetries } from "./onemin.ts";
import { outputTokensFor, thinkingOptions } from "./thinking.ts";

// Bot API topic-name cap.
const MAX_TITLE_CHARS = 128;
// Long first messages title no better than their opening — cap the input
// so a pasted log doesn't inflate a throwaway call.
const MAX_INPUT_CHARS = 2_000;

export async function generateTopicTitle(
	model: LanguageModel,
	firstText: string,
	providerOptions?: ProviderOptions,
	maxRetries?: number,
	avoid?: string,
	maxOutputTokens?: number,
): Promise<string | null> {
	const input = firstText.slice(0, MAX_INPUT_CHARS);
	// A re-title (avoid set) names the whole chat, not its opening, and
	// must not hand back the title the operator already has.
	const result = await generateText({
		model,
		instructions:
			(avoid === undefined
				? "Write a short title — a few words — for a chat that begins with the " +
					"message below. "
				: "Write a short title — a few words — for the chat summarized by the " +
					`messages below. The current title is "${avoid}"; write a different one. `) +
			"Output only the title: no quotes, no preamble, no trailing period.",
		prompt: input,
		...(providerOptions ? { providerOptions } : {}),
		...(maxRetries !== undefined ? { maxRetries } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	});
	const title = sanitizeTitle(result.text);
	// A throwaway call is still a cost line — log usage with the cache
	// split or a titling anomaly can't be reconstructed from the log.
	log.info("title model call", {
		model: typeof model === "string" ? model : `${model.provider}/${model.modelId}`,
		usage: {
			input: result.usage.inputTokens ?? null,
			cacheRead: result.usage.inputTokenDetails?.cacheReadTokens ?? null,
			cacheWrite: result.usage.inputTokenDetails?.cacheWriteTokens ?? null,
			output: result.usage.outputTokens ?? null,
		},
		title,
	});
	return title;
}

// Strip the quote/markdown decoration the model was told not to add;
// enforce the Telegram cap.
export function sanitizeTitle(raw: string): string | null {
	const first = raw.split("\n", 1)[0] ?? "";
	const title = first
		.replace(/^[\s"'`#*_>]+/, "")
		.replace(/[\s"'`#*_>.…]+$/, "")
		.replace(/\s+/g, " ");
	if (title === "") return null;
	return [...title].slice(0, MAX_TITLE_CHARS).join("");
}

// The dedicated titleModel wins; unset, the conversation's own model
// writes the title under a tight output cap — a title is a few words,
// not a turn-sized budget.
const TITLE_ANSWER_TOKENS = 256;

// No titleModel and no fallback ref answers null. boot() builds it once
// for the spin-off pin deps.
export function makeTitleFor(deps: {
	configRef: ConfigRef;
	auth: AuthStore;
	observation: CacheObservation;
}): (
	text: string,
	opts?: { avoid?: string; model?: string },
) => Promise<string | null> {
	return async (text, opts) => {
		const cfg = deps.configRef.current;
		const ref = cfg.titleModel ?? opts?.model;
		if (ref === undefined) return null;
		const model = await resolveModel(cfg, deps.auth, ref);
		return generateTopicTitle(
			observedModel(model, {
				purpose: "topic-title",
				observation: deps.observation,
				route: cacheRouteFor(cfg, ref),
			}),
			text,
			thinkingOptions(cfg, ref, "off"),
			modelCallMaxRetries(cfg, ref),
			opts?.avoid,
			// The configured titleModel is the operator's small-model pick
			// — cap only the conversation-model fallback, which wasn't.
			cfg.titleModel === undefined
				? outputTokensFor(cfg, ref, "off", TITLE_ANSWER_TOKENS)
				: undefined,
		);
	};
}
