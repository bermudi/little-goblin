// thinkingOptions is a boundary contract: the operator vocabulary must
// land on knobs each provider family actually has. GLM's per-generation
// semantics (docs.z.ai/guides) motivated this test — send glm-5.3 an
// effort it doesn't list and the API silently upgrades to max.
// thinkingLevelsFor is the same table read the other way: what /think
// and the mini app may offer.

import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { thinkingLevelsFor, thinkingOptions } from "./providers.ts";

const cfg: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", auth: "zai" },
		other: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "other" },
		openrouter: { kind: "openrouter", auth: "openrouter" },
	},
	model: "zai/glm-5.3-flash",
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
	http: { port: 8787 },
	logLevel: "info",
};

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
	test("everything else gets the full vocabulary", () => {
		expect(thinkingLevelsFor("openai-compatible", "whatever-9")).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"max",
		]);
		expect(thinkingLevelsFor("openrouter", "x/y")).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"max",
		]);
		expect(thinkingLevelsFor("", "glm-5.3")).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"max",
		]);
	});
});

describe("thinkingOptions — glm-5.3+ (forced thinking, effort low|high|max)", () => {
	test("off and medium clamp to real rungs; low/high/max pass through", () => {
		const eff = (l: "off" | "low" | "medium" | "high" | "max") =>
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
		expect(eff("max")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — glm-5.2 (toggle + effort high|max)", () => {
	test("off sends the disabled toggle, never an effort", () => {
		expect(thinkingOptions(cfg, "zai/glm-5.2", "off")).toEqual({
			zai: { thinking: { type: "disabled" } },
		});
	});
	test("low collapses up to high — GLM's own collapse direction", () => {
		expect(thinkingOptions(cfg, "zai/glm-5.2", "low")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
	});
	test("max reaches the top rung", () => {
		expect(thinkingOptions(cfg, "zai/glm-5.2", "max")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — older glm (toggle only)", () => {
	test("off disables; anything else enables with no effort key", () => {
		expect(thinkingOptions(cfg, "zai/glm-4.6", "off")).toEqual({
			zai: { thinking: { type: "disabled" } },
		});
		expect(thinkingOptions(cfg, "zai/glm-4.6", "high")).toEqual({
			zai: { thinking: { type: "enabled" } },
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
});
