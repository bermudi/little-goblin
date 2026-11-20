// These cases pin AI SDK v4 usage fields and their mapping into Goblin's usage shape.
import { describe, expect, test } from "bun:test";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { generateText } from "ai";
import type { Usage } from "../message.ts";
import { generateModel, textResult } from "../testkit/fake-model.ts";
import { fromV4Usage } from "./v4-usage.ts";

const fullUsage: LanguageModelV4Usage = {
	inputTokens: { total: 17, noCache: 8, cacheRead: 5, cacheWrite: 4 },
	outputTokens: { total: 9, text: 6, reasoning: 3 },
	raw: { source: "fixture" },
};

describe("fromV4Usage", () => {
	test("maps full provider usage to goblin usage", () => {
		expect(fromV4Usage(fullUsage)).toEqual({
			inputTokens: 17,
			inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 5, cacheWriteTokens: 4 },
			outputTokens: 9,
			outputTokenDetails: { textTokens: 6, reasoningTokens: 3 },
			totalTokens: 26,
			raw: { source: "fixture" },
		} satisfies Usage);
	});

	test("preserves missing counters and follows the SDK total-count rule", () => {
		const partial: LanguageModelV4Usage = {
			inputTokens: { total: undefined, noCache: undefined, cacheRead: 0, cacheWrite: undefined },
			outputTokens: { total: 3, text: undefined, reasoning: 3 },
		};
		expect(fromV4Usage(partial)).toEqual({
			inputTokens: undefined,
			inputTokenDetails: {
				noCacheTokens: undefined,
				cacheReadTokens: 0,
				cacheWriteTokens: undefined,
			},
			outputTokens: 3,
			outputTokenDetails: { textTokens: undefined, reasoningTokens: 3 },
			totalTokens: 3,
		});
		expect(
			fromV4Usage({
				inputTokens: { total: 2, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
				outputTokens: { total: undefined, text: undefined, reasoning: undefined },
			}).totalTokens,
		).toBe(2);
		expect(
			fromV4Usage({
				inputTokens: {
					total: undefined,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: undefined, text: undefined, reasoning: undefined },
			}).totalTokens,
		).toBeUndefined();
	});

	test("matches the AI SDK generateText usage for the same fake provider result", async () => {
		const model = generateModel(() => ({
			...textResult("ok"),
			usage: fullUsage,
		}));
		const result = await generateText({ model: model.model, prompt: "hello" });
		expect(fromV4Usage(fullUsage)).toEqual(result.usage);
	});
});
