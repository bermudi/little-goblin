import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import type { Usage } from "../message.ts";

export function fromV4Usage(u: LanguageModelV4Usage): Usage {
	return {
		inputTokens: u.inputTokens.total,
		inputTokenDetails: {
			noCacheTokens: u.inputTokens.noCache,
			cacheReadTokens: u.inputTokens.cacheRead,
			cacheWriteTokens: u.inputTokens.cacheWrite,
		},
		outputTokens: u.outputTokens.total,
		outputTokenDetails: {
			textTokens: u.outputTokens.text,
			reasoningTokens: u.outputTokens.reasoning,
		},
		totalTokens:
			u.inputTokens.total == null && u.outputTokens.total == null
				? undefined
				: (u.inputTokens.total ?? 0) + (u.outputTokens.total ?? 0),
		...(u.raw === undefined ? {} : { raw: u.raw }),
	};
}
