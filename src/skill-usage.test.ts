import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./testkit.ts";
import {
	freshUsageRecord,
	noteSkillPatch,
	noteSkillUse,
	readSkillUsage,
	usageAnchor,
	writeSkillUsage,
} from "./skill-usage.ts";

const tmp = (): { root: string; usagePath: string } => {
	const root = tmpDir("goblin-skillusage-test-");
	return { root, usagePath: join(root, "skill-usage.json") };
};

describe("skill usage sidecar", () => {
	test("absent file reads empty and a bump creates the record", () => {
		const { usagePath } = tmp();
		expect(readSkillUsage(usagePath)).toEqual({ lastCuratorRun: null, skills: {} });
		const now = new Date("2026-11-17T00:00:00.000Z");
		noteSkillUse(usagePath, "herdr", now);
		const file = readSkillUsage(usagePath);
		expect(file.skills["herdr"]).toMatchObject({
			useCount: 1,
			lastUsedAt: now.toISOString(),
			state: "active",
			pinned: false,
		});
	});

	test("use and patch bump independently and keep each other's counts", () => {
		const { usagePath } = tmp();
		const a = new Date("2026-11-17T00:00:00.000Z");
		const b = new Date("2026-11-17T01:00:00.000Z");
		noteSkillUse(usagePath, "herdr", a);
		noteSkillPatch(usagePath, "herdr", b);
		noteSkillUse(usagePath, "herdr", b);
		const rec = readSkillUsage(usagePath).skills["herdr"]!;
		expect(rec.useCount).toBe(2);
		expect(rec.patchCount).toBe(1);
		expect(rec.lastUsedAt).toBe(b.toISOString());
		expect(rec.lastPatchedAt).toBe(b.toISOString());
	});

	test("a corrupt file fails loud, not silently reset", () => {
		const { usagePath } = tmp();
		writeFileSync(usagePath, "{not json");
		expect(() => readSkillUsage(usagePath)).toThrow(/corrupt skill usage sidecar/);
		writeFileSync(usagePath, JSON.stringify({ skills: { "bad name": {} } }));
		expect(() => readSkillUsage(usagePath)).toThrow();
	});

	test("the inactivity anchor is lastUsedAt ?? createdAt", () => {
		const neverUsed = freshUsageRecord(new Date("2026-11-17T00:00:00.000Z"));
		expect(usageAnchor(neverUsed)).toBe(neverUsed.createdAt);
		const used = { ...neverUsed, lastUsedAt: "2026-11-10T00:00:00.000Z" };
		expect(usageAnchor(used)).toBe("2026-11-10T00:00:00.000Z");
	});

	test("whole-file write round-trips", () => {
		const { usagePath } = tmp();
		const file = {
			lastCuratorRun: null,
			skills: { herdr: freshUsageRecord(new Date()) },
		};
		writeSkillUsage(usagePath, file);
		expect(readSkillUsage(usagePath)).toEqual(file);
	});
});
