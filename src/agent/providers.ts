// Provider registry: config name → AI SDK provider factory + auth
// reference. Thinking maps to per-provider providerOptions — honest about
// which providers support which levels.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { AuthStore } from "../auth.ts";
import { splitModelRef, type Config, type ThinkingLevel } from "../config.ts";

export async function resolveModel(
	config: Config,
	auth: AuthStore,
	modelRef: string,
): Promise<LanguageModel> {
	const { provider, modelId } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (!p) {
		throw new Error(
			`model "${modelRef}": provider "${provider}" not in goblin.json5 providers`,
		);
	}
	const apiKey = await auth.resolve(p.auth);
	switch (p.kind) {
		case "openai-compatible":
			return createOpenAICompatible({
				name: provider,
				baseURL: p.baseUrl,
				apiKey,
			}).chatModel(modelId);
		case "openrouter":
			// The provider package's response-metadata types use nullable
			// fields that predate exactOptionalPropertyTypes — structurally
			// it's the same spec-v2 LanguageModel.
			return createOpenRouter({ apiKey }).chat(modelId) as unknown as LanguageModel;
	}
}

// Thinking level → providerOptions. Levels the provider can't express are
// mapped to the nearest honest equivalent — never silently invented.
export function thinkingOptions(
	config: Config,
	modelRef: string,
	level: ThinkingLevel,
): ProviderOptions | undefined {
	const { provider } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (!p) return undefined;
	switch (p.kind) {
		case "openrouter":
			// "off" is just enabled:false — pairing it with an effort is a
			// contradiction providers may reject outright.
			if (level === "off") {
				return { openrouter: { reasoning: { enabled: false, exclude: true } } };
			}
			return { openrouter: { reasoning: { effort: level } } };
		case "openai-compatible":
			// OpenAI-compatible surface: reasoningEffort is the only knob the
			// SDK exposes. "off" maps to the lowest effort rather than an
			// invented disable flag.
			return {
				[provider]: { reasoningEffort: level === "off" ? "low" : level },
			};
	}
}
