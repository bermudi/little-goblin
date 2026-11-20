// One-shot model calls outside the turn; the only place side jobs reach the model layer.

import { generateText, isStepCount, type LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { FinishReason, Usage } from "../message.ts";
import type { Tools } from "../tool.ts";
import { toToolSet } from "../turn/ai-sdk-tools.ts";
import { fromSdkError } from "./sdk-errors.ts";

export type Model = LanguageModel;

export interface ModelCall {
	model: Model;
	providerOptions?: ProviderOptions;
	maxRetries?: number;
	maxOutputTokens?: number;
}

export interface GenerateRequest {
	call: ModelCall;
	instructions: string;
	prompt: string;
	tools?: Tools;
	maxSteps?: number;
	signal?: AbortSignal;
}

export interface Generated {
	text: string;
	finishReason: FinishReason;
	usage: Usage;
	steps: number;
	toolCalls: number;
}

export async function generate(req: GenerateRequest): Promise<Generated> {
	const result = await generateText({
		...req.call,
		instructions: req.instructions,
		prompt: req.prompt,
		...(req.tools !== undefined ? { tools: toToolSet(req.tools) } : {}),
		...(req.maxSteps !== undefined ? { stopWhen: isStepCount(req.maxSteps) } : {}),
		...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
	}).catch((err: unknown) => {
		// Side jobs' callers (the compaction walk) sort goblin's shape.
		throw fromSdkError(err);
	});
	return {
		text: result.text,
		finishReason: result.finishReason,
		usage: {
			inputTokens: result.usage.inputTokens,
			inputTokenDetails: {
				noCacheTokens: result.usage.inputTokenDetails?.noCacheTokens,
				cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
				cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens,
			},
			outputTokens: result.usage.outputTokens,
			outputTokenDetails: {
				textTokens: result.usage.outputTokenDetails?.textTokens,
				reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
			},
			totalTokens: result.usage.totalTokens,
			...(result.usage.raw !== undefined ? { raw: result.usage.raw } : {}),
		},
		steps: result.steps.length,
		toolCalls: result.steps.reduce((n, step) => n + step.toolCalls.length, 0),
	};
}
