// The settings catalog is data — these pin its shape against the real
// config schemas so a renamed auth default or provider kind drifts red.

import { describe, expect, test } from "bun:test";
import { authDefaults, capabilityNames, providerSchema, reviewerConfigSchema } from "./config.ts";
import { capabilityDefaults, capabilityHints, providerPresets, serviceNames } from "./services.ts";

describe("service catalog", () => {
	test("every provider preset parses through providerSchema; id = provider name = auth record, or the kind's auth default", () => {
		expect(providerPresets.length).toBeGreaterThan(0);
		for (const preset of providerPresets) {
			expect(providerSchema.safeParse(preset.provider).success).toBe(true);
			const expected = preset.provider.kind === "claude-code" ? authDefaults.claudeCode : preset.id;
			expect("auth" in preset.provider && preset.provider.auth).toBe(expected);
		}
		expect(serviceNames.codex).toBe("ChatGPT");
		expect(serviceNames.zai).toBe("Z.ai");
	});

	test("capability hints cover all parkable blocks; defaults stay parseable", () => {
		expect(Object.keys(capabilityHints).sort()).toEqual([...capabilityNames].sort());
		for (const name of Object.keys(capabilityDefaults)) {
			expect(capabilityHints[name as (typeof capabilityNames)[number]]).toBeNull();
		}
		expect(reviewerConfigSchema.safeParse(capabilityDefaults.reviewer).success).toBe(true);
	});
});
