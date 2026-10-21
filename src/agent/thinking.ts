// The operator's thinking vocabulary against each model's real knob.
//
// One profile per (kind, model) says three things: which levels the
// model supports, what "off" means on it, and which wire knob carries
// a level. The ladder the app offers IS the profile — never a generic
// list with a guess inside it.
//
// Sources, in order of honesty:
// - openrouter: the per-model `reasoning` object in GET /api/v1/models
//   (supported_efforts, mandatory) — openrouter.ai/docs/use-cases/
//   reasoning-tokens, "Discovering per-model reasoning options".
// - z.ai GLM and the OpenAI/codex families: the vendor's own tables
//   (docs.z.ai/guides, the OpenAI effort vocabulary).
// - anything else: unknown. An unknown route keeps the whole vocabulary
//   and the endpoint rejects what it doesn't take — fail loud, never
//   fake knowledge.
//
// Two rules hold everywhere:
// - A level the model can't express is never offered. glm-5.3 offers
//   low|high|max and nothing else; minimax-m3.1-flash offers
//   low|medium|high|xhigh|max with no "off" (its reasoning is
//   mandatory).
// - "off" is only offered when it genuinely turns reasoning off. A
//   model whose thinking is forced has no "off" rung, and a stored
//   "off" clamps to the model's weakest rung instead of asking the
//   provider to disable something it cannot disable.

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { splitModelRef, thinkingLevels, type Config, type ThinkingLevel } from "../config.ts";
import { openrouterRoute, type OpenRouterRoute } from "./models-dev.ts";

// The effort rungs, weakest first. "off" is not a rung — it is a state
// the model may or may not support.
const RUNGS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

// The set every OpenAI-compatible endpoint has taken since reasoning
// effort existed. "minimal" is newer and provider-published — an
// endpoint we know nothing about does not get it.
const CLASSIC_RUNGS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * What "off" means on a model.
 * - disable: reasoning can be switched off; "off" is offered and says so.
 * - floor: the model has no disable; a stored "off" clamps to the
 *   weakest rung (the vocabulary's "off isn't a rung" rule).
 * - always: the model has no reasoning at all; "off" describes it and
 *   the wire carries nothing.
 * - default: the route's shape is unknown; "off" means the route's own
 *   default, so the wire carries nothing — never a disable we cannot
 *   back.
 */
export type OffMeaning = "disable" | "floor" | "always" | "default";

export interface ReasoningProfile {
	/** The rungs the model supports, weakest first. */
	levels: readonly ThinkingLevel[];
	/** What "off" means on this model. */
	off: OffMeaning;
	/** The wire knob that carries a rung. */
	knob: "effort" | "toggle" | "none";
}

/** The nearest rung at or above the requested one — the collapse direction. */
function clampToLevels(levels: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
	const idx = thinkingLevels.indexOf(level);
	const atOrAbove = levels.find((l) => thinkingLevels.indexOf(l) >= idx);
	return atOrAbove ?? levels[levels.length - 1] ?? level;
}

// ---------- openrouter ----------

// The route's own truth. `supported_parameters` says which knobs the
// route takes; the `reasoning` object says which efforts it has and
// whether reasoning can be switched off.
function openrouterProfile(route: OpenRouterRoute | null): ReasoningProfile {
	if (route === null) {
		// Unknown route: the whole vocabulary, and "off" means the
		// route's default. Nothing is claimed that the endpoint cannot
		// back — a stored "off" must never ask a mandatory model to
		// stop thinking.
		return { levels: [...RUNGS], off: "default", knob: "effort" };
	}
	const r = route.reasoning;
	if (r === null) {
		// No per-model reasoning object: a non-reasoning model, or a
		// dynamic router that picks the model per request.
		if (!route.params.has("reasoning") && !route.params.has("reasoning_effort")) {
			return { levels: [], off: "always", knob: "none" };
		}
		// The route takes reasoning knobs but publishes no per-model
		// truth — "off" stays the route's default rather than a guess.
		return { levels: [...RUNGS], off: "default", knob: "effort" };
	}
	if (r.supported_efforts === undefined || r.supported_efforts === null) {
		// Reasoning without effort selection: one state (on, at the
		// model's own default) and the toggle that turns it off.
		return {
			levels: ["low"],
			off: r.mandatory === true ? "floor" : "disable",
			knob: "toggle",
		};
	}
	const levels = RUNGS.filter((rung) => r.supported_efforts!.includes(rung));
	if (levels.length === 0) {
		// A published effort set goblin cannot express — keep the model
		// usable and let the endpoint judge the value.
		return { levels: [...RUNGS], off: "default", knob: "effort" };
	}
	return {
		levels,
		// A mandatory model rejects a disable ("Reasoning is mandatory
		// for this endpoint and cannot be disabled") — so "off" is not
		// offered, and a stored "off" clamps to the weakest rung.
		off: r.mandatory === true ? "floor" : "disable",
		knob: "effort",
	};
}

function openrouterOptions(modelId: string, level: ThinkingLevel): ProviderOptions | undefined {
	const profile = openrouterProfile(openrouterRoute(modelId));
	if (profile.knob === "none") return undefined;
	if (level === "off") {
		if (profile.off === "disable") {
			// The documented disable for an effort route is the "none"
			// effort — every non-mandatory model in the catalog lists it
			// among its efforts. A toggle route takes the switch itself.
			return profile.knob === "effort"
				? { openrouter: { reasoning: { effort: "none" } } }
				: { openrouter: { reasoning: { enabled: false, exclude: true } } };
		}
		if (profile.off === "floor") {
			// Forced thinking: the weakest rung stands in for the disable.
			return openrouterRung(profile, clampToLevels(profile.levels, "off"));
		}
		// "default"/"always": the route reasons or not on its own — send
		// nothing rather than a disable we cannot back.
		return undefined;
	}
	return openrouterRung(profile, clampToLevels(profile.levels, level));
}

function openrouterRung(
	profile: ReasoningProfile,
	rung: ThinkingLevel,
): ProviderOptions | undefined {
	if (profile.knob === "toggle") return { openrouter: { reasoning: { enabled: true } } };
	return { openrouter: { reasoning: { effort: rung } } };
}

// ---------- z.ai GLM ----------

// GLM 5.3+ is forced thinking on the effort ladder low|high|max; 5.2
// toggles plus high|max; ≤4.6 toggles only. The coding-plan endpoint
// aliases every glm id to the 5.3 generation (docs.z.ai/devpack).
function glmProfile(modelId: string, baseUrl?: string): ReasoningProfile {
	const { major, minor } = glmVersion(modelId);
	if (zaiCodingEndpoint(baseUrl)) return { levels: ["low", "high", "max"], off: "floor", knob: "effort" };
	if (major > 5 || (major === 5 && minor >= 3)) {
		return { levels: ["low", "high", "max"], off: "floor", knob: "effort" };
	}
	if (major === 5 && minor === 2) return { levels: ["high", "max"], off: "disable", knob: "effort" };
	return { levels: ["low"], off: "disable", knob: "toggle" };
}

// GLM's own collapse: 5.3+ takes low|high|max and silently upgrades an
// unlisted effort to max (docs.z.ai/guides); 5.2 collapses everything
// below high onto high.
function glmEffort(levels: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
	if (levels.length === 0) return "low";
	const idx = thinkingLevels.indexOf(level);
	const atOrAbove = levels.find((l) => thinkingLevels.indexOf(l) >= idx);
	return atOrAbove ?? levels[levels.length - 1]!;
}

function openaiCompatibleThinking(
	provider: string,
	modelId: string,
	level: ThinkingLevel,
	baseUrl?: string,
): ProviderOptions {
	// Options use the first dot-separated provider segment ("z.ai" → "z").
	const key = provider.split(".")[0]!.trim();
	if (modelId.startsWith("glm-")) {
		const profile = glmProfile(modelId, baseUrl);
		if (level === "off") {
			if (profile.off === "disable") return { [key]: { thinking: { type: "disabled" } } };
			// Forced thinking: the weakest rung stands in for the disable.
			return {
				[key]: { thinking: { type: "enabled" }, reasoningEffort: profile.levels[0] ?? "low" },
			};
		}
		if (profile.knob === "toggle") return { [key]: { thinking: { type: "enabled" } } };
		return {
			[key]: {
				thinking: { type: "enabled" },
				reasoningEffort: glmEffort(profile.levels, level),
			},
		};
	}
	if (modelId.startsWith("gpt-")) {
		return {
			[key]: { reasoningEffort: clampToLevels(gptLevels(modelId), level) },
		};
	}
	// Generic providers expose effort only; "off" falls to the lowest effort.
	return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
}

// ---------- openai / codex ----------

// GPT-6 adds `max`; older GPT ladders stop at `xhigh`. "off" isn't a
// rung and clamps to the floor.
function gptLevels(modelId: string): readonly ThinkingLevel[] {
	const major = Number(/^gpt-(\d+)/.exec(modelId)?.[1] ?? 0);
	if (major >= 6) return ["low", "medium", "high", "xhigh", "max"];
	return ["low", "medium", "high", "xhigh"];
}

// ---------- the profile ----------

export function reasoningProfileFor(
	kind: string,
	modelId: string,
	baseUrl?: string,
): ReasoningProfile {
	// Bare id, including relayed names; z.ai coding aliases all GLM ids
	// to its forced-thinking ladder.
	const bare = modelId.split("/").pop() ?? modelId;
	if (kind === "openrouter") {
		// The catalog's own truth wins: it knows this route's efforts
		// and whether its reasoning can be disabled.
		const route = openrouterRoute(modelId);
		if (route !== null) return openrouterProfile(route);
	}
	if (bare.startsWith("glm-")) return glmProfile(bare, baseUrl);
	if (kind === "codex" || bare.startsWith("gpt-")) {
		return { levels: gptLevels(bare), off: "floor", knob: "effort" };
	}
	if (kind === "openrouter") {
		// An unlisted route: unknown, so the whole vocabulary and "off"
		// as the route's default.
		return openrouterProfile(null);
	}
	// A generic OpenAI-compatible endpoint: the classic effort set, and
	// "off" as the floor (the endpoint may reject "none"). "minimal" is
	// offered only where a provider publishes it.
	return { levels: [...CLASSIC_RUNGS], off: "floor", knob: "effort" };
}

/**
 * The levels to offer for a model — exactly what it supports.
 */
export function thinkingLevelsFor(
	kind: string,
	modelId: string,
	baseUrl?: string,
): readonly ThinkingLevel[] {
	const profile = reasoningProfileFor(kind, modelId, baseUrl);
	if (profile.off === "always") return ["off"];
	if (profile.off === "disable" || profile.off === "default") {
		return ["off", ...profile.levels];
	}
	return [...profile.levels];
}

/**
 * The wire form of one level. A level the model can't express is
 * clamped to the nearest rung at-or-above; "off" never asks a model to
 * disable reasoning it cannot disable.
 */
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
		case "openrouter":
			return openrouterOptions(modelId, level);
		case "openai-compatible":
			return openaiCompatibleThinking(provider, bare, level, p.baseUrl);
		case "responses": {
			// Responses GLM uses a forced-thinking effort ladder; "off" is the floor.
			const key = provider.split(".")[0]!.trim();
			if (bare.startsWith("glm-")) {
				const profile = glmProfile(bare, p.baseUrl);
				if (level === "off") {
					if (profile.off === "disable") return { [key]: { reasoningEffort: "low" } };
					return { [key]: { reasoningEffort: profile.levels[0] ?? "low" } };
				}
				return { [key]: { reasoningEffort: glmEffort(profile.levels, level) } };
			}
			return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
		}
		case "codex":
			// Codex has no "off" rung, so clamp to its available effort ladder.
			return {
				codex: { reasoningEffort: clampToLevels(gptLevels(bare), level) },
			};
	}
}

// Match z.ai's coding chat and Responses doors, but not the general paas path.
function zaiCodingEndpoint(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const u = new URL(baseUrl);
		if (u.hostname !== "api.z.ai") return false;
		// Non-empty segments — a trailing slash must not matter.
		const segments = u.pathname.split("/").filter(Boolean);
		return segments.includes("coding") || segments.join("/") === "api/v1";
	} catch {
		return false;
	}
}

function glmVersion(modelId: string): { major: number; minor: number } {
	const m = /^glm-(\d+)\.(\d+)/.exec(modelId);
	return { major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0 };
}
