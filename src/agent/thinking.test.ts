// The ladder the app offers is the model's own truth: what it can
// express, and nothing else. Send glm-5.3 an effort it doesn't list
// and the API silently upgrades to max (docs.z.ai/guides) — the
// operator vocabulary must land on knobs each provider family has, and
// a level a model cannot express must never be offered at all.
//
// The openrouter arms are pinned to the live catalog's per-model
// `reasoning` object (openrouter.ai/docs/use-cases/reasoning-tokens):
// supported_efforts says which efforts the route takes, mandatory says
// whether reasoning can be switched off. A mandatory model answers a
// disable with "Reasoning is mandatory for this endpoint and cannot be
// disabled" — probed on minimax-m3.1-flash, minimax-m2 and
// deepseek-r1-0528.

import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { _primeOpenRouterCatalog, type OpenRouterRoute } from "./models-dev.ts";
import { clampThinkingFor, thinkingLevelsFor, thinkingOptions } from "./thinking.ts";

const cfg: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", auth: "zai" },
		zai_responses: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
		relay_responses: { kind: "responses", baseUrl: "https://relay.example/v1", auth: "other" },
		other: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "other" },
		// Dotted name — the shape the SDK's first-segment lookup rule exists for.
		"z.ai": { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4", auth: "zai" },
		openrouter: { kind: "openrouter", auth: "openrouter" },
		codex: { kind: "codex" },
	},
	model: "zai/glm-5.3-flash",
	tts: false,
	favorites: [],
	thinking: "medium",
	operators: [1],
	allowedUsers: [1],
	telegram: { enabled: true, dmGapMinutes: 45, richReplies: true, showReasoning: false },
	http: { port: 8787 },
	logLevel: "info",
};

// The catalog's own shape for one route.
function route(params: string[], reasoning: OpenRouterRoute["reasoning"] = null): OpenRouterRoute {
	return { params: new Set(params), reasoning };
}

// The live catalog's entries for the models the ladders are pinned to.
const CATALOG = new Map<string, OpenRouterRoute>([
	// minimax-m3.1-flash:free — mandatory, efforts max|xhigh|high|medium|low.
	[
		"minimax/minimax-m3.1-flash:free",
		route(["reasoning", "reasoning_effort"], {
			mandatory: true,
			supported_efforts: ["max", "xhigh", "high", "medium", "low"],
			default_effort: "max",
		}),
	],
	// gpt-5.4 — reasoning optional, "none" among the efforts.
	[
		"openai/gpt-5.4",
		route(["reasoning", "reasoning_effort"], {
			mandatory: false,
			default_enabled: true,
			supported_efforts: ["xhigh", "high", "medium", "low", "none"],
			default_effort: "medium",
		}),
	],
	// deepseek-r1 — reasoning without effort selection, and mandatory.
	["deepseek/deepseek-r1-0528", route(["reasoning"], { mandatory: true })],
	// A plain model with no reasoning at all.
	["plain/model", route(["tools"])],
	// A route that takes reasoning knobs but publishes no per-model truth.
	["effort/model", route(["reasoning", "reasoning_effort"])],
	// z.ai's GLM through openrouter — the same forced ladder it serves
	// directly.
	[
		"z-ai/glm-5.3",
		route(["reasoning", "reasoning_effort"], {
			mandatory: true,
			default_enabled: true,
			supported_efforts: ["max", "high", "low"],
			default_effort: "max",
		}),
	],
]);

function primeCatalog(): void {
	_primeOpenRouterCatalog(new Map(CATALOG));
}

describe("thinkingLevelsFor — the ladder is the model's own set", () => {
	test("glm-5.3 offers low, high and max — no off, no medium, no xhigh", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-5.3-flash")).toEqual(["low", "high", "max"]);
	});
	test("glm-5.2 toggles and tops out at max", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-5.2")).toEqual(["off", "high", "max"]);
	});
	test("older glm is a bare toggle", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-4.6")).toEqual(["off", "low"]);
	});
	test("gpt ladders: no off; gpt-6 adds max", () => {
		expect(thinkingLevelsFor("codex", "gpt-5.3-codex")).toEqual(["low", "medium", "high", "xhigh"]);
		expect(thinkingLevelsFor("codex", "gpt-6-astra")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
	test("family ladders follow the bare model id under any kind", () => {
		// A glm-5.3 is forced-thinking wherever it's served — even via a
		// relay that nests a vendor prefix or an unknown provider kind.
		expect(thinkingLevelsFor("openai-compatible", "gpt-6-astra")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(thinkingLevelsFor("", "glm-5.3")).toEqual(["low", "high", "max"]);
	});
	test("a generic endpoint offers the classic effort set, minus a disable it cannot honor", () => {
		expect(thinkingLevelsFor("openai-compatible", "whatever-9")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
});

describe("thinkingLevelsFor — openrouter reads the model's own reasoning object", () => {
	test("a mandatory model has no off — its thinking cannot be disabled", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "minimax/minimax-m3.1-flash:free")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
	test("a model that can be turned off offers it", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "openai/gpt-5.4")).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});
	test("reasoning without effort selection is one rung — on, at the model's default", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "deepseek/deepseek-r1-0528")).toEqual(["low"]);
	});
	test("a model with no reasoning at all offers nothing but off", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "plain/model")).toEqual(["off"]);
	});
	test("a route with no published reasoning object keeps the whole vocabulary", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "effort/model")).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
	test("an unlisted route is unknown, not unsupported — the whole vocabulary", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "unknown/model")).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
	test("glm through openrouter keeps z.ai's own ladder", () => {
		primeCatalog();
		expect(thinkingLevelsFor("openrouter", "z-ai/glm-5.3")).toEqual(["low", "high", "max"]);
	});
});

describe("clampThinkingFor — the stored level is always one the model offers", () => {
	test("glm-5.3: xhigh collapses up to max, medium to high, off to the floor", () => {
		const clamp = (l: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") =>
			clampThinkingFor(cfg.providers, "zai/glm-5.3-flash", l);
		expect(clamp("xhigh")).toBe("max");
		expect(clamp("medium")).toBe("high");
		expect(clamp("minimal")).toBe("low");
		expect(clamp("off")).toBe("low");
		expect(clamp("low")).toBe("low");
		expect(clamp("high")).toBe("high");
		expect(clamp("max")).toBe("max");
	});
	test("glm-5.2 keeps a real off but collapses low up to high", () => {
		expect(clampThinkingFor(cfg.providers, "other/glm-5.2", "off")).toBe("off");
		expect(clampThinkingFor(cfg.providers, "other/glm-5.2", "low")).toBe("high");
		expect(clampThinkingFor(cfg.providers, "other/glm-5.2", "medium")).toBe("high");
	});
	test("gpt-5.x has no max — it clamps to its top rung", () => {
		expect(clampThinkingFor(cfg.providers, "codex/gpt-5.3-codex", "max")).toBe("xhigh");
		expect(clampThinkingFor(cfg.providers, "codex/gpt-6-astra", "max")).toBe("max");
	});
	test("a provider the config doesn't know keeps the level verbatim", () => {
		expect(clampThinkingFor(cfg.providers, "ghost/model", "xhigh")).toBe("xhigh");
		expect(clampThinkingFor(cfg.providers, "ghost/model", "off")).toBe("off");
	});
	test("an unlisted openrouter route owns its vocabulary — nothing clamps", () => {
		primeCatalog();
		expect(clampThinkingFor(cfg.providers, "openrouter/unknown/model", "xhigh")).toBe("xhigh");
		expect(clampThinkingFor(cfg.providers, "openrouter/unknown/model", "off")).toBe("off");
	});
	test("a mandatory model's stored off lands on its weakest rung", () => {
		primeCatalog();
		expect(
			clampThinkingFor(cfg.providers, "openrouter/minimax/minimax-m3.1-flash:free", "off"),
		).toBe("low");
		expect(
			clampThinkingFor(cfg.providers, "openrouter/minimax/minimax-m3.1-flash:free", "minimal"),
		).toBe("low");
	});
	test("a model with no reasoning at all stores off", () => {
		primeCatalog();
		expect(clampThinkingFor(cfg.providers, "openrouter/plain/model", "xhigh")).toBe("off");
	});
	test("a cold openrouter catalog is unknown — nothing clamps, the whole vocabulary shows", () => {
		// The name arms would narrow a selection the warm catalog supports
		// (gpt-5.4 publishes "none" — off is real there); a route the
		// catalog can't answer keeps its level verbatim.
		_primeOpenRouterCatalog(null);
		expect(thinkingLevelsFor("openrouter", "openai/gpt-5.4")).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(clampThinkingFor(cfg.providers, "openrouter/openai/gpt-5.4", "off")).toBe("off");
		expect(clampThinkingFor(cfg.providers, "openrouter/z-ai/glm-5.3", "xhigh")).toBe("xhigh");
	});
});

describe("thinkingOptions — glm-5.3+ (forced thinking, effort low|high|max)", () => {
	test("off and medium clamp to real rungs; low/high/max pass through", () => {
		const eff = (l: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") =>
			thinkingOptions(cfg, "zai/glm-5.3-flash", l);
		expect(eff("off")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
		expect(eff("low")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
		expect(eff("medium")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(eff("high")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(eff("xhigh")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
		expect(eff("max")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — glm-5.2 (toggle + effort high|max)", () => {
	// "other" serves real generations — on z.ai's coding-plan URL these
	// ids would alias to 5.3-gen.
	test("off sends the disabled toggle, never an effort", () => {
		expect(thinkingOptions(cfg, "other/glm-5.2", "off")).toEqual({
			other: { thinking: { type: "disabled" } },
		});
	});
	test("low collapses up to high — GLM's own collapse direction", () => {
		expect(thinkingOptions(cfg, "other/glm-5.2", "low")).toEqual({
			other: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
	});
	test("max reaches the top rung", () => {
		expect(thinkingOptions(cfg, "other/glm-5.2", "max")).toEqual({
			other: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — older glm (toggle only)", () => {
	test("off disables; anything else enables with no effort key", () => {
		expect(thinkingOptions(cfg, "other/glm-4.6", "off")).toEqual({
			other: { thinking: { type: "disabled" } },
		});
		expect(thinkingOptions(cfg, "other/glm-4.6", "high")).toEqual({
			other: { thinking: { type: "enabled" } },
		});
	});
});

describe("z.ai coding plan — older glm ids alias to 5.3-gen", () => {
	// docs.z.ai/devpack: the plan only serves glm-5.3/5.3-flash and
	// routes glm-5.2/5.1→5.3, glm-4.7→5.3-flash — an "older" id on that
	// endpoint runs forced thinking, so the wire map follows the
	// endpoint, not the id. cfg.zai's baseUrl is the coding-plan URL.
	test("offered set is the 5.3 ladder for any glm id", () => {
		expect(
			thinkingLevelsFor("openai-compatible", "glm-4.6", "https://api.z.ai/api/coding/paas/v4"),
		).toEqual(["low", "high", "max"]);
	});
	test("the general paas endpoint still serves real generations", () => {
		expect(
			thinkingLevelsFor("openai-compatible", "glm-4.6", "https://api.z.ai/api/paas/v4"),
		).toEqual(["off", "low"]);
	});
	test("wire mapping follows the routed model", () => {
		expect(thinkingOptions(cfg, "zai/glm-4.6", "medium")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "zai/glm-4.6", "off")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
	});
});

describe("thinkingOptions — codex and gpt (reasoning_effort ladder)", () => {
	test("off lands on the floor; real rungs pass through", () => {
		expect(thinkingOptions(cfg, "codex/gpt-6-astra", "off")).toEqual({
			codex: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "codex/gpt-6-astra", "xhigh")).toEqual({
			codex: { reasoningEffort: "xhigh" },
		});
		expect(thinkingOptions(cfg, "codex/gpt-6-astra", "max")).toEqual({
			codex: { reasoningEffort: "max" },
		});
	});
	test("a stored max on a 5.x model clamps to its top rung", () => {
		expect(thinkingOptions(cfg, "codex/gpt-5.3-codex", "max")).toEqual({
			codex: { reasoningEffort: "xhigh" },
		});
	});
	test("gpt via an openai-compatible relay clamps the same way", () => {
		expect(thinkingOptions(cfg, "other/gpt-6-astra", "off")).toEqual({
			other: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "other/gpt-6-astra", "max")).toEqual({
			other: { reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — provider options key", () => {
	// openai-compatible resolves options under name.split(".")[0] —
	// keying under the full name silently drops them.
	test("a dotted provider name keys options under its first segment", () => {
		expect(thinkingOptions(cfg, "z.ai/glm-5.2", "high")).toEqual({
			z: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "z.ai/gpt-6-astra", "off")).toEqual({
			z: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "z.ai/whatever-9", "medium")).toEqual({
			z: { reasoningEffort: "medium" },
		});
	});
});

describe("thinkingOptions — non-glm openai-compatible and openrouter", () => {
	test("generic endpoint keeps the reasoning_effort passthrough", () => {
		expect(thinkingOptions(cfg, "other/whatever-9", "medium")).toEqual({
			other: { reasoningEffort: "medium" },
		});
		expect(thinkingOptions(cfg, "other/whatever-9", "off")).toEqual({
			other: { reasoningEffort: "low" },
		});
	});
});

describe("thinkingOptions — openrouter speaks the model's own dialect", () => {
	test("a mandatory model never gets a disable — off becomes its weakest rung", () => {
		primeCatalog();
		expect(thinkingOptions(cfg, "openrouter/minimax/minimax-m3.1-flash:free", "off")).toEqual({
			openrouter: { reasoning: { effort: "low" } },
		});
		expect(thinkingOptions(cfg, "openrouter/minimax/minimax-m3.1-flash:free", "high")).toEqual({
			openrouter: { reasoning: { effort: "high" } },
		});
	});
	test("a model that can be turned off gets the documented 'none' effort", () => {
		primeCatalog();
		expect(thinkingOptions(cfg, "openrouter/openai/gpt-5.4", "off")).toEqual({
			openrouter: { reasoning: { effort: "none" } },
		});
		expect(thinkingOptions(cfg, "openrouter/openai/gpt-5.4", "medium")).toEqual({
			openrouter: { reasoning: { effort: "medium" } },
		});
	});
	test("a level the model doesn't take collapses to the nearest rung above it", () => {
		primeCatalog();
		// gpt-5.4 takes no "max" — the top rung stands in.
		expect(thinkingOptions(cfg, "openrouter/openai/gpt-5.4", "max")).toEqual({
			openrouter: { reasoning: { effort: "xhigh" } },
		});
		// minimax takes no "minimal" — its floor stands in.
		expect(thinkingOptions(cfg, "openrouter/minimax/minimax-m3.1-flash:free", "minimal")).toEqual({
			openrouter: { reasoning: { effort: "low" } },
		});
	});
	test("a toggle-only model takes the switch, not an effort", () => {
		primeCatalog();
		expect(thinkingOptions(cfg, "openrouter/deepseek/deepseek-r1-0528", "low")).toEqual({
			openrouter: { reasoning: { enabled: true } },
		});
		// Mandatory: a stored "off" is the model's own forced thinking.
		expect(thinkingOptions(cfg, "openrouter/deepseek/deepseek-r1-0528", "off")).toEqual({
			openrouter: { reasoning: { enabled: true } },
		});
	});
	test("a model with no reasoning carries nothing at all", () => {
		primeCatalog();
		expect(thinkingOptions(cfg, "openrouter/plain/model", "off")).toBeUndefined();
		expect(thinkingOptions(cfg, "openrouter/plain/model", "high")).toBeUndefined();
	});
	test("an unknown route never gets a disable it cannot back", () => {
		primeCatalog();
		// "off" on a route whose shape is unknown means the route's own
		// default — sending enabled:false is what a mandatory model
		// rejects.
		expect(thinkingOptions(cfg, "openrouter/unknown/model", "off")).toBeUndefined();
		expect(thinkingOptions(cfg, "openrouter/unknown/model", "high")).toEqual({
			openrouter: { reasoning: { effort: "high" } },
		});
	});
	test("a route with no published reasoning object keeps the enable/disable switch", () => {
		primeCatalog();
		expect(thinkingOptions(cfg, "openrouter/effort/model", "off")).toBeUndefined();
		expect(thinkingOptions(cfg, "openrouter/effort/model", "high")).toEqual({
			openrouter: { reasoning: { effort: "high" } },
		});
	});
});

describe("responses kind — the /api/v1 door", () => {
	test("glm on the coding endpoint is forced-thinking, whichever door", () => {
		expect(thinkingLevelsFor("responses", "glm-5.3-flash", "https://api.z.ai/api/v1")).toEqual([
			"low",
			"high",
			"max",
		]);
		// The endpoint aliases older glm ids to the 5.3 generation it serves.
		expect(thinkingLevelsFor("responses", "glm-4.6", "https://api.z.ai/api/v1")).toEqual([
			"low",
			"high",
			"max",
		]);
	});

	test("the /api/v1 door matches with or without a trailing slash, and only that path", () => {
		// glm-5.2's own ladder is off|high|max — low|high|max proves the
		// coding-endpoint arm fired, whichever way the base URL is spelled.
		expect(thinkingLevelsFor("responses", "glm-5.2", "https://api.z.ai/api/v1/")).toEqual([
			"low",
			"high",
			"max",
		]);
		expect(thinkingLevelsFor("openai-compatible", "glm-5.2", "https://api.z.ai/api/v1/")).toEqual([
			"low",
			"high",
			"max",
		]);
		// The general paas path is not the coding door — 5.2 keeps its ladder.
		expect(
			thinkingLevelsFor("openai-compatible", "glm-5.2", "https://api.z.ai/api/paas/v4"),
		).toEqual(["off", "high", "max"]);
	});

	test("glm thinking maps to the OpenAI effort knob (probe: low→7, high→37 reasoning tokens)", () => {
		expect(thinkingOptions(cfg, "zai_responses/glm-5.3-flash", "off")).toEqual({
			zai_responses: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "zai_responses/glm-5.3-flash", "medium")).toEqual({
			zai_responses: { reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "zai_responses/glm-5.3-flash", "xhigh")).toEqual({
			zai_responses: { reasoningEffort: "max" },
		});
	});

	test("non-glm models pass the level through; off means the floor", () => {
		expect(thinkingOptions(cfg, "relay_responses/gpt-6-astra", "high")).toEqual({
			relay_responses: { reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "relay_responses/gpt-6-astra", "off")).toEqual({
			relay_responses: { reasoningEffort: "low" },
		});
	});
});
