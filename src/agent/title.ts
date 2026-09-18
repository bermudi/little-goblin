// Topic titler — one small generateText call that turns a conversation's
// first text into a Telegram topic name, ChatGPT-style. Knows nothing
// about Telegram beyond the 128-char name cap; the caller owns the
// editForumTopic boundary.

import { generateText, type LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

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
	const result = await generateText({
		model,
		system:
			"Write a short title — a few words — for a chat that begins with the " +
			"message below. Output only the title: no quotes, no preamble, no " +
			"trailing period.",
		prompt: firstText.slice(0, MAX_INPUT_CHARS),
		...(providerOptions ? { providerOptions } : {}),
	});
	return sanitizeTitle(result.text);
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
