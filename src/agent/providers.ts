// Provider registry: config name → AI SDK provider factory + auth
// reference. Thinking maps to per-provider providerOptions — honest about
// which providers support which levels.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { AuthStore } from "../auth.ts";
import {
	splitModelRef,
	thinkingLevels,
	type Config,
	type ThinkingLevel,
} from "../config.ts";

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

// Thinking level → providerOptions. The levels are an operator
// vocabulary, not a provider contract — each family maps them to the
// nearest honest equivalent, and collapses are written down here, never
// silently invented.
export function thinkingOptions(
	config: Config,
	modelRef: string,
	level: ThinkingLevel,
): ProviderOptions | undefined {
	const { provider, modelId } = splitModelRef(modelRef);
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
			return openaiCompatibleThinking(provider, modelId, level);
	}
}

// OpenAI-compatible endpoints: the honest knob depends on the model
// family, which is knowable from the model id, not the provider name.
function openaiCompatibleThinking(
	provider: string,
	modelId: string,
	level: ThinkingLevel,
): ProviderOptions {
	if (modelId.startsWith("glm-")) return glmThinking(provider, modelId, level);
	// Generic surface: reasoning_effort is the only knob the SDK exposes;
	// "off" degrades to the lowest effort rather than an invented disable.
	return { [provider]: { reasoningEffort: level === "off" ? "low" : level } };
}

// The levels a model can actually express — what /think and the mini app
// offer. Stored values outside the set aren't rejected: config defaults
// span models with different ladders, so thinkingOptions clamps them.
// Unknown kinds/models get the full vocabulary — the passthrough fails
// loud if the endpoint can't take it.
export function thinkingLevelsFor(
	kind: string,
	modelId: string,
): readonly ThinkingLevel[] {
	if (kind === "openai-compatible" && modelId.startsWith("glm-")) {
		const { major, minor } = glmVersion(modelId);
		if (major > 5 || (major === 5 && minor >= 3)) return ["low", "high", "max"];
		if (major === 5 && minor === 2) return ["off", "high", "max"];
		return ["off", "low"];
	}
	return thinkingLevels;
}

// GLM generations express thinking differently (docs.z.ai/guides):
//   glm-5.3+ — forced thinking; reasoning_effort is low|high|max and any
//              other value silently becomes max. "off" can only mean the
//              floor: low.
//   glm-5.2  — thinking.type toggle + effort high|max (others → max).
//   older    — thinking.type enabled|disabled only; effort doesn't exist.
// Unknown future majors (glm-6+) get the 5.3 treatment — forced thinking
// is the trajectory, and an effort param is likelier accepted than a
// "disabled" toggle that forced-thinking models reject outright.
function glmThinking(
	provider: string,
	modelId: string,
	level: ThinkingLevel,
): ProviderOptions {
	const { major, minor } = glmVersion(modelId);
	if (major > 5 || (major === 5 && minor >= 3)) {
		const effort = { off: "low", low: "low", medium: "high", high: "high", max: "max" }[level];
		return {
			[provider]: { thinking: { type: "enabled" }, reasoningEffort: effort },
		};
	}
	if (major === 5 && minor === 2) {
		if (level === "off") return { [provider]: { thinking: { type: "disabled" } } };
		const effort = { low: "high", medium: "high", high: "high", max: "max" }[level];
		return {
			[provider]: { thinking: { type: "enabled" }, reasoningEffort: effort },
		};
	}
	return { [provider]: { thinking: { type: level === "off" ? "disabled" : "enabled" } } };
}

function glmVersion(modelId: string): { major: number; minor: number } {
	const m = /^glm-(\d+)\.(\d+)/.exec(modelId);
	return { major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0 };
}
