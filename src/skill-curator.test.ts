import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, useHome } from "./testkit.ts";
import { paths } from "./home-layout.ts";
import { SkillSources } from "./skill-provenance.ts";
import { openStore } from "./conversation.ts";
import {
	curatorConfig,
	curatorStatusRows,
	passDue,
	restoreArchivedSkill,
	runCuratorPass,
	setSkillPinned,
	type CuratorConfig,
} from "./skill-curator.ts";
import { freshUsageRecord, noteSkillUse, readSkillUsage, writeSkillUsage } from "./skill-usage.ts";

// The pass and archive helpers resolve dirs through paths(), so a
// throwaway home pins them per test.
function home(): { usagePath: string; sources: SkillSources } {
	const h = useHome("goblin-curator-test-");
	mkdirSync(paths.skills(), { recursive: true });
	mkdirSync(join(h, "state"), { recursive: true });
	const store = openStore(paths.db());
	const sources = new SkillSources(store.db);
	return { usagePath: paths.skillUsage(), sources };
}

const CFG: CuratorConfig = curatorConfig({}) ?? {
	staleDays: 14,
	archiveDays: 30,
};

const DAY = 86_400_000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY);

const seedSkill = (name: string): void => {
	mkdirSync(join(paths.skills(), name), { recursive: true });
	writeFileSync(
		join(paths.skills(), name, "SKILL.md"),
		`---\nname: ${name}\ndescription: test\n---\n\nbody\n`,
	);
};

describe("curator config", () => {
	test("absent block is off; present parses with defaults", () => {
		expect(curatorConfig(undefined)).toBeUndefined();
		expect(curatorConfig({})).toEqual({ staleDays: 14, archiveDays: 30 });
		expect(curatorConfig({ staleDays: 7 })).toEqual({ staleDays: 7, archiveDays: 30 });
		expect(() => curatorConfig({ staleDays: 0 })).toThrow();
		expect(() => curatorConfig({ bogus: true })).toThrow();
	});
});

describe("curator pass", () => {
	test("first sight seeds the clock and defers every transition", () => {
		const { usagePath, sources } = home();
		sources.record("app/1", "fresh-skill", "turn");
		const now = new Date();
		// A record older than archiveDays still defers: the pass never
		// saw the skill before.
		const file = readSkillUsage(usagePath);
		const old = { ...freshUsageRecord(ago(90)) };
		file.skills["fresh-skill"] = old;
		writeSkillUsage(usagePath, file);
		const { file: next, counters } = runCuratorPass(
			readSkillUsage(usagePath),
			sources.managedNames(),
			CFG,
			now,
		);
		expect(counters.seeded).toBe(0); // already had a record: checked instead
		expect(next.lastCuratorRun).toBe(now.toISOString());
	});

	test("first sight with no record seeds and skips", () => {
		const { usagePath, sources } = home();
		sources.record("app/1", "never-seen", "turn");
		const now = new Date();
		const { file, counters } = runCuratorPass(
			readSkillUsage(usagePath),
			sources.managedNames(),
			CFG,
			now,
		);
		expect(counters.seeded).toBe(1);
		expect(counters.archived).toBe(0);
		expect(file.skills["never-seen"]?.firstSeenAt).toBe(now.toISOString());
	});

	test("unmanaged records never transition", () => {
		const { usagePath, sources } = home();
		const file = readSkillUsage(usagePath);
		// An operator-installed skill: record exists (a use), no row.
		const rec = freshUsageRecord(ago(90));
		file.skills["operator-skill"] = { ...rec, useCount: 1 };
		writeSkillUsage(usagePath, file);
		const { file: next } = runCuratorPass(
			readSkillUsage(usagePath),
			sources.managedNames(), // empty: no provenance rows
			CFG,
			new Date(),
		);
		expect(next.skills["operator-skill"]?.state).toBe("active");
	});

	test("stale after cutoff, archived after archive cutoff, dir moves", () => {
		const { usagePath, sources } = home();
		seedSkill("old-skill");
		sources.record("app/1", "old-skill", "turn");
		let file = readSkillUsage(usagePath);
		file.skills["old-skill"] = { ...freshUsageRecord(ago(20)), useCount: 3, lastUsedAt: ago(20).toISOString() };
		writeSkillUsage(usagePath, file);
		let out = runCuratorPass(readSkillUsage(usagePath), sources.managedNames(), CFG, new Date());
		expect(out.file.skills["old-skill"]?.state).toBe("stale");
		expect(out.counters.markedStale).toBe(1);

		// Age past the archive cutoff: dir moves to the archive.
		file = readSkillUsage(usagePath);
		file.skills["old-skill"] = {
			...file.skills["old-skill"]!,
			lastUsedAt: ago(40).toISOString(),
		};
		writeSkillUsage(usagePath, file);
		out = runCuratorPass(readSkillUsage(usagePath), sources.managedNames(), CFG, new Date());
		expect(out.file.skills["old-skill"]?.state).toBe("archived");
		expect(out.counters.archived).toBe(1);
		// The dir moved: stamped under the archive root.
		const archiveRoot = readdirSync(paths.skillsArchive());
		expect(archiveRoot.length).toBe(1);
		expect(archiveRoot[0]).toMatch(/^old-skill\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
		expect(existsSync(join(paths.skills(), "old-skill"))).toBe(false);
	});

	test("useCount 0 never archives before stale cutoff", () => {
		const { usagePath, sources } = home();
		seedSkill("quiet-skill");
		sources.record("app/1", "quiet-skill", "turn");
		const file = readSkillUsage(usagePath);
		// Created 40 days ago, never used.
		file.skills["quiet-skill"] = freshUsageRecord(ago(40));
		writeSkillUsage(usagePath, file);
		const out = runCuratorPass(readSkillUsage(usagePath), sources.managedNames(), CFG, new Date());
		// The useCount-0 guard only protects inside the stale window;
		// past it hermes lets the anchor rule decide. Hermes: "use_count
		// === 0 never archives before the stale cutoff" — past the
		// cutoff the normal anchor math applies.
		expect(out.counters.archived).toBe(1);
	});

	test("pinned skills skip every transition", () => {
		const { usagePath, sources } = home();
		seedSkill("pinned-skill");
		sources.record("app/1", "pinned-skill", "turn");
		const file = readSkillUsage(usagePath);
		file.skills["pinned-skill"] = {
			...freshUsageRecord(ago(40)),
			useCount: 1,
			lastUsedAt: ago(40).toISOString(),
			pinned: true,
		};
		writeSkillUsage(usagePath, file);
		const out = runCuratorPass(readSkillUsage(usagePath), sources.managedNames(), CFG, new Date());
		expect(out.counters.skippedPinned).toBe(1);
		expect(out.counters.archived).toBe(0);
		expect(out.file.skills["pinned-skill"]?.state).toBe("active");
	});

	test("a stale skill used again reactivates", () => {
		const { usagePath, sources } = home();
		seedSkill("back-skill");
		sources.record("app/1", "back-skill", "turn");
		const file = readSkillUsage(usagePath);
		file.skills["back-skill"] = {
			...freshUsageRecord(ago(20)),
			useCount: 1,
			lastUsedAt: ago(20).toISOString(),
			state: "stale",
		};
		writeSkillUsage(usagePath, file);
		// A use after going stale — the anchor is now recent.
		noteSkillUse(paths.skillUsage(), "back-skill", new Date());
		const out = runCuratorPass(readSkillUsage(usagePath), sources.managedNames(), CFG, new Date());
		expect(out.file.skills["back-skill"]?.state).toBe("active");
		expect(out.counters.reactivated).toBe(1);
	});

	test("a symlinked skill dir is refused and stays active", () => {
		const { usagePath, sources } = home();
		seedSkill("link-target");
		const linkedHome = tmpDir("goblin-curator-link-");
		symlinkSync(join(paths.skills(), "link-target"), join(paths.skills(), "linked-skill"));
		sources.record("app/1", "linked-skill", "turn");
		const file = readSkillUsage(usagePath);
		file.skills["linked-skill"] = {
			...freshUsageRecord(ago(60)),
			useCount: 2,
			lastUsedAt: ago(60).toISOString(),
		};
		writeSkillUsage(usagePath, file);
		const out = runCuratorPass(readSkillUsage(usagePath), sources.managedNames(), CFG, new Date());
		expect(out.file.skills["linked-skill"]?.state).toBe("active");
		// HTTP HEAD check: the symlink still resolves.
		expect(readSkillUsage(usagePath).skills["linked-skill"]?.state).toBe("active");
	});
});

describe("curator surfaces", () => {
	test("passDue honors the 168h interval", () => {
		expect(passDue({ lastCuratorRun: null, skills: {} }, new Date())).toBe(true);
		const recent = new Date(Date.now() - DAY).toISOString();
		expect(passDue({ lastCuratorRun: recent, skills: {} }, new Date())).toBe(false);
		const old = new Date(Date.now() - 169 * 3_600_000).toISOString();
		expect(passDue({ lastCuratorRun: old, skills: {} }, new Date())).toBe(true);
	});

	test("status rows join managed names and records", () => {
		const { usagePath, sources } = home();
		sources.record("app/1", "managed-blank", "turn");
		const file = readSkillUsage(usagePath);
		file.skills["recorded"] = { ...freshUsageRecord(ago(3)), useCount: 5 };
		const rows = curatorStatusRows(file, sources.managedNames(), new Date());
		expect(rows.map((r) => r.skill)).toEqual(["recorded"]);
		expect(rows[0]?.idleDays).toBe(3);
	});

	test("pin persists; unknown skills refuse; unpin works", () => {
		const { usagePath, sources } = home();
		sources.record("app/1", "known", "turn");
		expect(setSkillPinned(usagePath, "unknown", true, sources.managedNames())).toBe(false);
		expect(setSkillPinned(usagePath, "known", true, sources.managedNames())).toBe(true);
		expect(readSkillUsage(usagePath).skills["known"]?.pinned).toBe(true);
		// A recorded-but-unmanaged skill can pin too (telemetry row).
		const file = readSkillUsage(usagePath);
		file.skills["recorded"] = freshUsageRecord(new Date());
		writeSkillUsage(usagePath, file);
		expect(setSkillPinned(usagePath, "recorded", true, sources.managedNames())).toBe(true);
		expect(setSkillPinned(usagePath, "known", false, sources.managedNames())).toBe(true);
		expect(readSkillUsage(usagePath).skills["known"]?.pinned).toBe(false);
	});

	test("restore moves the newest archived copy back and flips the record", () => {
		const { usagePath } = home();
		mkdirSync(join(paths.skillsArchive(), "gone.2026-11-01T00-00-00"), {
			recursive: true,
		});
		mkdirSync(join(paths.skillsArchive(), "gone.2026-11-05T00-00-00"), {
			recursive: true,
		});
		writeFileSync(
			join(paths.skillsArchive(), "gone.2026-11-01T00-00-00", "SKILL.md"),
			"old",
		);
		writeFileSync(
			join(paths.skillsArchive(), "gone.2026-11-05T00-00-00", "SKILL.md"),
			"new",
		);
		const file = readSkillUsage(usagePath);
		file.skills["gone"] = {
			...freshUsageRecord(ago(40)),
			state: "archived",
			archivedAt: ago(1).toISOString(),
		};
		writeSkillUsage(usagePath, file);
		const out = restoreArchivedSkill(usagePath, "gone");
		expect(out.restored).toBe("gone");
		const restoredBody = readFileSync(join(paths.skills(), "gone", "SKILL.md"), "utf8");
		expect(restoredBody).toBe("new");
		expect(readSkillUsage(usagePath).skills["gone"]?.state).toBe("active");
	});

	test("restore refuses a live collision and reports missing", () => {
		const { usagePath } = home();
		expect(restoreArchivedSkill(usagePath, "nothing").reason).toBe("no archive yet");
		mkdirSync(paths.skillsArchive(), { recursive: true });
		expect(restoreArchivedSkill(usagePath, "nothing").reason).toBe("not in archive");
		mkdirSync(join(paths.skillsArchive(), "gone.2026-11-01T00-00-00"));
		mkdirSync(join(paths.skills(), "gone"), { recursive: true });
		expect(restoreArchivedSkill(usagePath, "gone").reason).toContain("live skill");
	});
});
