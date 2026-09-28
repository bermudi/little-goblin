// Provider registry: config name → AI SDK provider factory + auth
// reference. Thinking maps to per-provider providerOptions — honest about
// which providers support which levels.

import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { AuthStore } from "../auth.ts";
import {
	splitModelRef,
	thinkingLevels,
	type Config,
	type ThinkingLevel,
} from "../config.ts";
import { log } from "../log.ts";
import { codexModel } from "./codex.ts";
import type { MediaPosition } from "./attachments.ts";
import { openrouterSupportedParams } from "./models-dev.ts";

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
	switch (p.kind) {
		case "openai-compatible":
			return createOpenAICompatible({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
			}).chatModel(modelId);
		case "responses":
			// `name` pins the providerOptions key to the config name — the
			// SDK resolves options under provider.split(".")[0], same rule
			// glmThinking applies.
			return createOpenAI({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
			}).responses(modelId);
		case "openrouter": {
			const apiKey = await auth.resolve(p.auth);
			// The provider package's response-metadata types use nullable
			// fields that predate exactOptionalPropertyTypes — structurally
			// it's the same spec-v4 LanguageModel.
			return createOpenRouter({ apiKey }).chat(modelId) as unknown as LanguageModel;
		}
		case "codex":
			return codexModel(modelId, p.authFile);
	}
}

// What each provider kind's pipe can carry on the wire, per position.
// Catalog modalities (models.dev) say what the MODEL accepts; this says
// what goblin's SDK converters can actually deliver to it — and the
// answer differs by where the part rides: user-message content and
// tool-result content are different converter paths, and two kinds
// express file parts in one while silently mangling them in the other.
// openai-compatible stringifies tool-result content (an 8 MiB PDF would
// ride as ~11 MB of base64 JSON text in every later request — no throw,
// just silent payload garbage), and codex's toolResultText filters to
// text (the framing survives, the payload drops). Attachment
// materialization and the fetch tool intersect catalog truth with this
// before inlining anything; anything the pipe can't carry degrades to
// its path reference, never a thrown turn and never silent garbage.
//
// Probe-verified against z.ai 2026-09-27 (see DESIGN.md, Web access):
//   responses (/api/v1): PDF input_file parses in user messages AND in
//   function_call_output; video/mp4 is rejected server-side.
//   openai-compatible (chat): file parts accepted server-side in both
//   positions, but the SDK only expresses user-message parts.
export function carriesMedia(
	kind: string,
	mediaType: string,
	position: MediaPosition = "user",
): boolean {
	switch (kind) {
		case "responses":
			// @ai-sdk/openai's Responses converter maps file parts in both
			// positions (input_file in user content and in
			// function_call_output content arrays).
			return mediaType.startsWith("image/") || mediaType === "application/pdf";
		case "openai-compatible":
			// Tool results are stringified by the converter — nothing
			// carries there, whatever the server would accept.
			if (position === "tool-result") return false;
			// User position: SDK v3 emits image_url / video_url / input_audio
			// / file parts. getAudioFormat expresses wav and mp3/mpeg only —
			// any other audio (Telegram voice notes are audio/ogg) throws at
			// request build, so those don't carry either.
			return (
				mediaType.startsWith("image/") ||
				mediaType.startsWith("video/") ||
				mediaType === "audio/wav" ||
				mediaType === "audio/mp3" ||
				mediaType === "audio/mpeg" ||
				mediaType === "application/pdf"
			);
		case "openrouter":
			// Normalizes everything, in both positions: user content gets
			// image_url / input_audio / a generic file part, tool-result
			// content gets real mapped parts (mapToolResultContentParts).
			return true;
		case "codex":
			// goblin's own converter (codex.ts): user messages take images
			// and PDFs; tool results keep text only.
			return (
				position === "user" &&
				(mediaType.startsWith("image/") || mediaType === "application/pdf")
			);
		default:
			// Unknown kinds carry the universal minimum, user messages only.
			return position === "user" && mediaType.startsWith("image/");
	}
}
// Per-model-call observability (DESIGN.md, Cache stability: "every
// model call logs … the request prefix hash"). The model boundary is
// the only seam that sees each call's actual params — a tool-using turn
// makes several calls the turn loop can't observe, and SDK retries land
// here too. headHash covers system + tools (the request head — must
// never move on its own); requestHash covers the whole prompt and moves
// by appends only. Same message count with a different hash, or a
// shrinking count, is the visible signature of a history rewrite.
export function observedModel(
	model: LanguageModel,
	context: { conversation?: string; purpose?: string },
): LanguageModel {
	// LanguageModel is also a provider-registry id string — nothing to
	// observe there. resolveModel only ever returns instances.
	if (typeof model === "string") return model;
	const middleware: LanguageModelMiddleware = {
		transformParams: async ({ type, params }) => {
			// The system prompt rides inside the prompt as leading system
			// messages — the head is those plus the tool definitions.
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
	// Family detection keys on the bare id — relays may nest a vendor
	// prefix ("relay/z-ai/glm-5.2"), same rule thinkingLevelsFor applies.
	const bare = modelId.split("/").pop() ?? modelId;
	switch (p.kind) {
		case "openrouter": {
			// "off" is just enabled:false — pairing it with an effort is a
			// contradiction providers may reject outright.
			if (level === "off") {
				return { openrouter: { reasoning: { enabled: false, exclude: true } } };
			}
			// OpenRouter's per-route supported_parameters decide: models that
			// take reasoning_effort get the verbatim level (OpenRouter folds
			// what the upstream can't express); toggle-only models get a plain
			// enable; non-reasoners get nothing at all. A cold catalog passes
			// the level through — the API rejects loudly if it can't take it.
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
			// /api/v1 serves the forced-thinking GLM generation; the OpenAI
			// effort knob is real there (probe 2026-09-27: effort low → 7
			// reasoning tokens, high → 37) and the ladder collapses like
			// glmThinking's forced-5.3 arm — "off" can only mean the floor.
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
			// reasoning_effort verbatim inside the model's ladder; "off"
			// isn't a codex rung, so it and any out-of-ladder stored value
			// clamp to the nearest rung at-or-above (then the top).
			return {
				codex: { reasoningEffort: clampToLadder(gptLevels(bare), level) },
			};
	}
}

// OpenAI-compatible endpoints: the honest knob depends on the model
// family, which is knowable from the model id, not the provider name —
// with one endpoint caveat: z.ai's coding plan only serves glm-5.3-gen
// models and silently routes older glm-* ids to them (docs.z.ai/devpack),
// so on that endpoint every glm is the forced-thinking generation.
function openaiCompatibleThinking(
	provider: string,
	modelId: string,
	level: ThinkingLevel,
	baseUrl?: string,
): ProviderOptions {
	// The SDK resolves provider options under the first dot-separated
	// segment of the provider name (config.provider.split(".")[0]) — a
	// provider named "z.ai" must key under "z" or the options are
	// silently dropped.
	const key = provider.split(".")[0]!.trim();
	if (modelId.startsWith("glm-")) {
		return glmThinking(key, modelId, level, zaiCodingEndpoint(baseUrl));
	}
	if (modelId.startsWith("gpt-")) {
		return {
			[key]: { reasoningEffort: clampToLadder(gptLevels(modelId), level) },
		};
	}
	// Generic surface: reasoning_effort is the only knob the SDK exposes;
	// "off" degrades to the lowest effort rather than an invented disable.
	return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
}

// api.z.ai coding-plan endpoints: the /api/coding/paas/* chat door and
// the /api/v1 Responses door (devpack endpoint table lists both as
// coding-plan quota). The general paas endpoint (no "coding" in the
// path) serves real per-generation GLMs, so the sniff stays scoped.
function zaiCodingEndpoint(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const u = new URL(baseUrl);
		if (u.hostname !== "api.z.ai") return false;
		return u.pathname.split("/").includes("coding") || u.pathname === "/api/v1";
	} catch {
		return false;
	}
}

// The levels a model can actually express — what the mini app
// offer. Stored values outside the set aren't rejected: config defaults
// span models with different ladders, so thinkingOptions clamps them.
// Unknown kinds/models get the full vocabulary — the passthrough fails
// loud if the endpoint can't take it.
export function thinkingLevelsFor(
	kind: string,
	modelId: string,
	baseUrl?: string,
): readonly ThinkingLevel[] {
	// Family ladders follow the bare model id under every kind — a glm-5.3
	// is forced-thinking whether z.ai serves it directly or via a relay
	// (openrouter nests a vendor prefix, e.g. "z-ai/glm-5.3"). And on z.ai's
	// coding-plan endpoint every glm-* is 5.3-gen regardless of the id —
	// the endpoint aliases older ids to the two models it actually serves.
	const bare = modelId.split("/").pop() ?? modelId;
	if (bare.startsWith("glm-")) {
		if (
			(kind === "openai-compatible" || kind === "responses") &&
			zaiCodingEndpoint(baseUrl)
		) {
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

// GPT effort ladders (platform.openai.com reasoning_effort): gpt-6 adds
// max on top of the 5.x-era low|medium|high|xhigh set. "off" is not
// offered — the floor is the lowest rung; stored "off" clamps to it.
function gptLevels(modelId: string): readonly ThinkingLevel[] {
	const major = Number(/^gpt-(\d+)/.exec(modelId)?.[1] ?? 0);
	if (major >= 6) return ["low", "medium", "high", "xhigh", "max"];
	return ["low", "medium", "high", "xhigh"];
}

// Clamp an arbitrary level onto a ladder: nearest rung at-or-above in
// vocabulary order, else the top rung. "off" lands on the lowest rung —
// "the least thinking available", never an invented disable.
function clampToLadder(
	ladder: readonly ThinkingLevel[],
	level: ThinkingLevel,
): ThinkingLevel {
	const idx = thinkingLevels.indexOf(level);
	return (
		ladder.find((l) => thinkingLevels.indexOf(l) >= idx) ??
		ladder[ladder.length - 1]!
	);
}

// OpenRouter per-route capability from its public /models catalog
// (supported_parameters). Cold/unknown catalog → full vocabulary: the
// passthrough fails loud rather than pretending knowledge we don't have.
function openrouterLevels(
	params: Set<string> | null,
): readonly ThinkingLevel[] {
	if (!params) return thinkingLevels;
	if (!params.has("reasoning") && !params.has("reasoning_effort")) {
		return ["off"];
	}
	if (!params.has("reasoning_effort")) return ["off", "low"];
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
