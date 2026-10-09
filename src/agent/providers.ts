import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { AuthStore } from "../auth.ts";
import { splitModelRef, thinkingLevels, type Config, type ThinkingLevel } from "../config.ts";
import { log } from "../log.ts";
import { codexModel } from "./codex/model.ts";
import type { MediaPosition } from "./attachments.ts";
import { isZaiHost, zaiReasoningFetch } from "./zai-responses.ts";
import { openrouterSupportedParams } from "./models-dev.ts";

export async function resolveModel(
	config: Config,
	auth: AuthStore,
	modelRef: string,
): Promise<LanguageModel> {
	const { provider, modelId } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (!p) {
		throw new Error(`model "${modelRef}": provider "${provider}" not in goblin.json5 providers`);
	}
	switch (p.kind) {
		case "openai-compatible":
			return createOpenAICompatible({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
			}).chatModel(modelId);
		case "responses":
			// z.ai emits raw reasoning_text events; the shim maps them to the
			// reasoning_summary shape expected by the SDK. `name` keeps options
			// keyed to this config provider.
			return createOpenAI({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
				...(isZaiHost(p.baseUrl) ? { fetch: zaiReasoningFetch() } : {}),
			}).responses(modelId);
		case "openrouter": {
			const apiKey = await auth.resolve(p.auth);
			// Provider metadata types lag exactOptionalPropertyTypes; the runtime
			// value still has the LanguageModel shape.
			return createOpenRouter({ apiKey }).chat(modelId) as unknown as LanguageModel;
		}
		case "codex":
			return codexModel(modelId, p.authFile);
	}
}

// Catalog modalities describe what a model accepts; this predicate describes
// what the SDK converter can carry at each position. Unsupported media falls
// back to its saved path rather than becoming silently corrupted content.
export function carriesMedia(
	kind: string,
	mediaType: string,
	position: MediaPosition = "user",
): boolean {
	switch (kind) {
		case "responses":
			// Responses maps file parts in user and function_call_output content.
			return mediaType.startsWith("image/") || mediaType === "application/pdf";
		case "openai-compatible":
			// Tool-result content is stringified, so no media survives this position.
			if (position === "tool-result") return false;
			// The SDK audio formatter accepts wav/mp3/mpeg only; Telegram ogg
			// therefore falls back instead of failing request construction.
			return (
				mediaType.startsWith("image/") ||
				mediaType.startsWith("video/") ||
				mediaType === "audio/wav" ||
				mediaType === "audio/mp3" ||
				mediaType === "audio/mpeg" ||
				mediaType === "application/pdf"
			);
		case "openrouter":
			// OpenRouter maps media in both user and tool-result content.
			return true;
		case "codex":
			// Codex accepts images/PDFs in user messages, text only in results.
			return (
				position === "user" && (mediaType.startsWith("image/") || mediaType === "application/pdf")
			);
		default:
			return position === "user" && mediaType.startsWith("image/");
	}
}
// Hash at the model boundary, the only seam that sees every call. `headHash`
// isolates system/tools; with that head unchanged, `requestHash` should evolve
// by prompt append rather than history rewrite.
export function observedModel(
	model: LanguageModel,
	context: { conversation?: string; purpose?: string },
): LanguageModel {
	if (typeof model === "string") return model;
	const middleware: LanguageModelMiddleware = {
		transformParams: async ({ type, params }) => {
			// Hash the leading system messages and tools as the request head.
			const system = params.prompt.filter((m) => m.role === "system");
			const headHash = createHash("sha256")
				.update(JSON.stringify({ system, tools: params.tools ?? null }))
				.digest("hex")
				.slice(0, 16);
			const requestHash = createHash("sha256")
				.update(JSON.stringify(params.prompt))
				.digest("hex")
				.slice(0, 16);
			log.info("model call", {
				...context,
				model: `${model.provider}/${model.modelId}`,
				call: type,
				messages: params.prompt.length,
				headHash,
				requestHash,
			});
			return params;
		},
	};
	return wrapLanguageModel({ model, middleware });
}

// Map thinking levels to provider-specific controls and clamp known ladders.
export function thinkingOptions(
	config: Config,
	modelRef: string,
	level: ThinkingLevel,
): ProviderOptions | undefined {
	const { provider, modelId } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (!p) return undefined;
	const bare = modelId.split("/").pop() ?? modelId;
	switch (p.kind) {
		case "openrouter": {
			// "off" disables reasoning; pairing it with effort may be rejected.
			if (level === "off") {
				return { openrouter: { reasoning: { enabled: false, exclude: true } } };
			}
			// For non-off levels, omit settings on known non-reasoning routes;
			// unknown catalog entries pass through for endpoint validation.
			const params = openrouterSupportedParams(modelId);
			if (params && !params.has("reasoning") && !params.has("reasoning_effort")) {
				return undefined;
			}
			if (params && !params.has("reasoning_effort")) {
				return { openrouter: { reasoning: { enabled: true } } };
			}
			return { openrouter: { reasoning: { effort: level } } };
		}
		case "openai-compatible":
			return openaiCompatibleThinking(provider, bare, level, p.baseUrl);
		case "responses": {
			// Responses GLM uses a forced-thinking effort ladder; "off" is the floor.
			const key = provider.split(".")[0]!.trim();
			if (bare.startsWith("glm-")) {
				const effort = {
					off: "low",
					low: "low",
					medium: "high",
					high: "high",
					xhigh: "max",
					max: "max",
				}[level];
				return { [key]: { reasoningEffort: effort } };
			}
			return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
		}
		case "codex":
			// Codex has no "off" rung, so clamp to its available effort ladder.
			return {
				codex: { reasoningEffort: clampToLadder(gptLevels(bare), level) },
			};
	}
}

// The model family determines the honest knob. z.ai coding endpoints alias
// every GLM id to the forced-thinking generation.
function openaiCompatibleThinking(
	provider: string,
	modelId: string,
	level: ThinkingLevel,
	baseUrl?: string,
): ProviderOptions {
	// Options use the first dot-separated provider segment ("z.ai" → "z").
	const key = provider.split(".")[0]!.trim();
	if (modelId.startsWith("glm-")) {
		return glmThinking(key, modelId, level, zaiCodingEndpoint(baseUrl));
	}
	if (modelId.startsWith("gpt-")) {
		return {
			[key]: { reasoningEffort: clampToLadder(gptLevels(modelId), level) },
		};
	}
	// Generic providers expose effort only; "off" falls to the lowest effort.
	return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
}

// Match z.ai's coding chat and Responses doors, but not the general paas path.
function zaiCodingEndpoint(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const u = new URL(baseUrl);
		if (u.hostname !== "api.z.ai") return false;
		// Compare non-empty segments so a trailing slash does not matter.
		const segments = u.pathname.split("/").filter(Boolean);
		return segments.includes("coding") || segments.join("/") === "api/v1";
	} catch {
		return false;
	}
}

// Return the active model's honest ladder; unknown models retain the full
// vocabulary so unsupported values fail at the endpoint rather than here.
export function thinkingLevelsFor(
	kind: string,
	modelId: string,
	baseUrl?: string,
): readonly ThinkingLevel[] {
	// Detect from the bare id, including relayed names; z.ai coding aliases all
	// GLM ids to its forced-thinking ladder.
	const bare = modelId.split("/").pop() ?? modelId;
	if (bare.startsWith("glm-")) {
		if ((kind === "openai-compatible" || kind === "responses") && zaiCodingEndpoint(baseUrl)) {
			return ["low", "high", "max"];
		}
		const { major, minor } = glmVersion(bare);
		if (major > 5 || (major === 5 && minor >= 3)) return ["low", "high", "max"];
		if (major === 5 && minor === 2) return ["off", "high", "max"];
		return ["off", "low"];
	}
	if (kind === "codex" || bare.startsWith("gpt-")) {
		return gptLevels(bare);
	}
	if (kind === "openrouter") {
		return openrouterLevels(openrouterSupportedParams(modelId));
	}
	return thinkingLevels;
}

// GPT-6 adds `max`; older GPT ladders stop at `xhigh`. "off" is clamped
// to the lowest available effort.
function gptLevels(modelId: string): readonly ThinkingLevel[] {
	const major = Number(/^gpt-(\d+)/.exec(modelId)?.[1] ?? 0);
	if (major >= 6) return ["low", "medium", "high", "xhigh", "max"];
	return ["low", "medium", "high", "xhigh"];
}

// Clamp to the nearest rung at or above the requested vocabulary level.
function clampToLadder(ladder: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
	const idx = thinkingLevels.indexOf(level);
	return ladder.find((l) => thinkingLevels.indexOf(l) >= idx) ?? ladder[ladder.length - 1]!;
}

// OpenRouter's catalog distinguishes effort, toggle-only, and non-reasoning
// routes; a cold catalog preserves the request so the provider can reject it.
function openrouterLevels(params: Set<string> | null): readonly ThinkingLevel[] {
	if (!params) return thinkingLevels;
	if (!params.has("reasoning") && !params.has("reasoning_effort")) {
		return ["off"];
	}
	if (!params.has("reasoning_effort")) return ["off", "low"];
	return thinkingLevels;
}

// GLM 5.3+ uses forced thinking with low/high/max effort; 5.2 combines a
// toggle with high/max, while older generations expose only a toggle.
// Future major versions follow the forced-thinking mapping.
function glmThinking(
	key: string,
	modelId: string,
	level: ThinkingLevel,
	forced53 = false,
): ProviderOptions {
	const { major, minor } = glmVersion(modelId);
	if (forced53 || major > 5 || (major === 5 && minor >= 3)) {
		const effort = {
			off: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		}[level];
		return {
			[key]: { thinking: { type: "enabled" }, reasoningEffort: effort },
		};
	}
	if (major === 5 && minor === 2) {
		if (level === "off") return { [key]: { thinking: { type: "disabled" } } };
		const effort = {
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		}[level];
		return {
			[key]: { thinking: { type: "enabled" }, reasoningEffort: effort },
		};
	}
	return { [key]: { thinking: { type: level === "off" ? "disabled" : "enabled" } } };
}

function glmVersion(modelId: string): { major: number; minor: number } {
	const m = /^glm-(\d+)\.(\d+)/.exec(modelId);
	return { major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0 };
}
