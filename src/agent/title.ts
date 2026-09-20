// Topic titler — one small generateText call that turns a conversation's
// first text into a Telegram topic name, ChatGPT-style. Knows nothing
// about Telegram beyond the 128-char name cap; the caller owns the
// editForumTopic boundary.

import { generateText, type LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { log } from "../log.ts";

// Bot API topic-name cap.
const MAX_TITLE_CHARS = 128;
// Long first messages title no better than their opening — cap the input
// so a pasted log doesn't inflate a throwaway call.
const MAX_INPUT_CHARS = 2_000;

export async function generateTopicTitle(
	model: LanguageModel,
	firstText: string,
	providerOptions?: ProviderOptions,
): Promise<string | null> {
	const input = firstText.slice(0, MAX_INPUT_CHARS);
	const result = await generateText({
		model,
		system:
			"Write a short title — a few words — for a chat that begins with the " +
			"message below. Output only the title: no quotes, no preamble, no " +
			"trailing period.",
		prompt: input,
		...(providerOptions ? { providerOptions } : {}),
	});
	const title = sanitizeTitle(result.text);
	// A model call is a cost line even when it's a throwaway — DESIGN.md
	// (Cache stability): every model call logs usage with the cached
	// split, or a titling anomaly can't be reconstructed from the log.
	// The request hashes ride the model-call wrapper (observedModel).
	log.info("title model call", {
		model: typeof model === "string" ? model : `${model.provider}/${model.modelId}`,
		usage: {
			input: result.usage.inputTokens ?? null,
			cached: result.usage.cachedInputTokens ?? null,
			output: result.usage.outputTokens ?? null,
		},
		title,
	});
	return title;
}

// Model output is a boundary: take the first line, strip quote/markdown
// decoration it was told not to add, enforce the Telegram cap.
export function sanitizeTitle(raw: string): string | null {
	const first = raw.split("\n", 1)[0] ?? "";
	const title = first
		.replace(/^[\s"'`#*_>]+/, "")
		.replace(/[\s"'`#*_>.…]+$/, "")
		.replace(/\s+/g, " ");
	if (title === "") return null;
	return [...title].slice(0, MAX_TITLE_CHARS).join("");
}
