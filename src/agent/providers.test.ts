// thinkingOptions is a boundary contract: the operator vocabulary must
// land on knobs each provider family actually has. GLM's per-generation
// semantics (docs.z.ai/guides) motivated this test — send glm-5.3 an
// effort it doesn't list and the API silently upgrades to max.
// thinkingLevelsFor is the same table read the other way: what the app
// and the mini app may offer.

import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { _primeOpenRouterCatalog } from "./models-dev.ts";
import { carriesMedia, thinkingLevelsFor, thinkingOptions } from "./providers.ts";

const cfg: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", auth: "zai" },
		// The Responses door (devpack endpoint table) — probe-verified
		// 2026-09-27: documents ride in user messages AND tool outputs.
		zai_responses: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
		relay_responses: { kind: "responses", baseUrl: "https://relay.example/v1", auth: "other" },
		other: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "other" },
		// Free-form name with a dot — the exact shape the SDK's lookup
		// key rule (first dot-separated segment) exists for.
		"z.ai": { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4", auth: "zai" },
		openrouter: { kind: "openrouter", auth: "openrouter" },
		codex: { kind: "codex" },
	},
	model: "zai/glm-5.3-flash",
	tts: false,
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
	http: { port: 8787 },
	logLevel: "info",
};

const FULL = ["off", "low", "medium", "high", "xhigh", "max"] as const;

describe("thinkingLevelsFor — the offered set", () => {
	test("glm-5.3+ has no off — thinking is forced", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-5.3-flash")).toEqual([
			"low",
			"high",
			"max",
		]);
	});
	test("glm-5.2 toggles and tops out at max", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-5.2")).toEqual([
			"off",
			"high",
			"max",
		]);
	});
	test("older glm is a bare toggle", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-4.6")).toEqual(["off", "low"]);
	});
	test("gpt ladders: no off; gpt-6 adds max", () => {
		expect(thinkingLevelsFor("codex", "gpt-5.3-codex")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
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
		expect(thinkingLevelsFor("openrouter", "z-ai/glm-5.3")).toEqual([
			"low",
			"high",
			"max",
		]);
		expect(thinkingLevelsFor("openai-compatible", "gpt-6-astra")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(thinkingLevelsFor("", "glm-5.3")).toEqual(["low", "high", "max"]);
	});
	test("openrouter falls to the per-route catalog", () => {
		_primeOpenRouterCatalog(
			new Map([
				["effort/model", new Set(["reasoning_effort", "tools"])],
				["toggle/model", new Set(["reasoning", "tools"])],
				["plain/model", new Set(["tools"])],
			]),
		);
		expect(thinkingLevelsFor("openrouter", "effort/model")).toEqual(FULL);
		expect(thinkingLevelsFor("openrouter", "toggle/model")).toEqual(["off", "low"]);
		expect(thinkingLevelsFor("openrouter", "plain/model")).toEqual(["off"]);
		// Unlisted → unknown, not unsupported: full vocabulary, fail loud.
		expect(thinkingLevelsFor("openrouter", "unknown/model")).toEqual(FULL);
		_primeOpenRouterCatalog(null);
	});
	test("everything else gets the full vocabulary", () => {
		expect(thinkingLevelsFor("openai-compatible", "whatever-9")).toEqual(FULL);
		expect(thinkingLevelsFor("openrouter", "x/y")).toEqual(FULL);
	});
});

describe("thinkingOptions — glm-5.3+ (forced thinking, effort low|high|max)", () => {
	test("off and medium clamp to real rungs; low/high/max pass through", () => {
		const eff = (l: "off" | "low" | "medium" | "high" | "xhigh" | "max") =>
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
	// "other" is a generic openai-compatible endpoint serving real
	// generations — on z.ai's coding-plan URL these ids alias to 5.3-gen.
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
	// docs.z.ai/devpack: the plan only serves glm-5.3/5.3-flash and routes
	// glm-5.2/5.1→5.3, glm-4.7→5.3-flash. An "older" id on that endpoint
	// runs a forced-thinking model, so levels and the wire map follow the
	// endpoint, not the id. cfg.zai's baseUrl is the coding-plan URL.
	test("offered set is the 5.3 ladder for any glm id", () => {
		expect(
			thinkingLevelsFor(
				"openai-compatible",
				"glm-4.6",
				"https://api.z.ai/api/coding/paas/v4",
			),
		).toEqual(["low", "high", "max"]);
	});
	test("the general paas endpoint still serves real generations", () => {
		expect(
			thinkingLevelsFor(
				"openai-compatible",
				"glm-4.6",
				"https://api.z.ai/api/paas/v4",
			),
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
	// The openai-compatible provider resolves options under
	// name.split(".")[0] — keying under the full name silently drops
	// them. Every model family must follow the rule.
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
	test("openrouter: off is enabled:false, levels pass through", () => {
		expect(thinkingOptions(cfg, "openrouter/x/y", "off")).toEqual({
			openrouter: { reasoning: { enabled: false, exclude: true } },
		});
		expect(thinkingOptions(cfg, "openrouter/x/y", "high")).toEqual({
			openrouter: { reasoning: { effort: "high" } },
		});
	});
	test("openrouter per-route: toggle-only enables, non-reasoners send nothing", () => {
		_primeOpenRouterCatalog(
			new Map([
				["toggle/model", new Set(["reasoning"])],
				["plain/model", new Set(["tools"])],
			]),
		);
		expect(thinkingOptions(cfg, "openrouter/toggle/model", "high")).toEqual({
			openrouter: { reasoning: { enabled: true } },
		});
		expect(thinkingOptions(cfg, "openrouter/plain/model", "high")).toBeUndefined();
		// "off" is still enabled:false even on a non-reasoner — trivially true.
		expect(thinkingOptions(cfg, "openrouter/plain/model", "off")).toEqual({
			openrouter: { reasoning: { enabled: false, exclude: true } },
		});
		_primeOpenRouterCatalog(null);
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

describe("carriesMedia — what the pipe can deliver", () => {
	test("responses carries probe-verified types only: images and PDFs", () => {
		expect(carriesMedia("responses", "application/pdf")).toBe(true);
		expect(carriesMedia("responses", "image/png")).toBe(true);
		// Server-side rejection, probe 2026-09-27: "Failed to parse the file."
		expect(carriesMedia("responses", "video/mp4")).toBe(false);
		expect(carriesMedia("responses", "application/zip")).toBe(false);
	});

	test("openai-compatible emits image/video/audio/pdf parts in user messages", () => {
		expect(carriesMedia("openai-compatible", "application/pdf")).toBe(true);
		expect(carriesMedia("openai-compatible", "video/mp4")).toBe(true);
		expect(carriesMedia("openai-compatible", "audio/ogg")).toBe(true);
		expect(carriesMedia("openai-compatible", "application/zip")).toBe(false);
	});

	test("openrouter normalizes everything; codex is goblin's own converter", () => {
		expect(carriesMedia("openrouter", "application/zip")).toBe(true);
		expect(carriesMedia("codex", "application/pdf")).toBe(true);
		expect(carriesMedia("codex", "video/mp4")).toBe(false);
	});

	test("unknown kinds carry the universal minimum", () => {
		expect(carriesMedia("mystery", "image/jpeg")).toBe(true);
		expect(carriesMedia("mystery", "application/pdf")).toBe(false);
	});
});
