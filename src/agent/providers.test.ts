// thinkingOptions is a boundary contract: the four-level operator
// vocabulary must land on knobs each provider family actually has.
// GLM's per-generation semantics (docs.z.ai/guides) are the table that
// motivated this test — send glm-5.3 an effort it doesn't list and the
// API silently upgrades to max.

import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { thinkingOptions } from "./providers.ts";

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

describe("thinkingOptions — glm-5.3+ (forced thinking, effort low|high|max)", () => {
	test("off degrades to the floor: low", () => {
		expect(thinkingOptions(cfg, "zai/glm-5.3-flash", "off")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
	});
	test("medium maps to high — the middle rung GLM actually has", () => {
		expect(thinkingOptions(cfg, "zai/glm-5.3-flash", "medium")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
	});
	test("high maps to max — the top rung", () => {
		expect(thinkingOptions(cfg, "zai/glm-5.3-flash", "high")).toEqual({
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
