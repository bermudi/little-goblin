import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import {
	liveStateOf,
	skillDiskPresence,
	SkillSources,
} from "./skill-provenance.ts";

const dirs: string[] = [];
const stores: ConversationStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { sources: SkillSources; workspace: string } {
	const dir = mkdtempSync(join(tmpdir(), "goblin-skillprov-test-"));
	dirs.push(dir);
	const store = openStore(join(dir, "state.sqlite"));
	stores.push(store);
	mkdirSync(join(dir, "skills"));
	mkdirSync(join(dir, "skills-proposed"));
	return {
		sources: new SkillSources(store.db),
		workspace: dir,
	};
}

test("records and upserts per (skill, conversation)", () => {
	const { sources } = fixture();
	sources.record("app/1", "herdr", "reviewer", "2026-10-16T00:00:00.000Z", "r1");
	// Same thread re-proposes: first generation moment stays, kind stays.
	sources.record("app/1", "herdr", "reviewer", "2026-10-16T02:00:00.000Z", "r2");
	// A turn edit later in the same thread advances last_at and widens kind.
	sources.record("app/1", "herdr", "turn", "2026-10-16T03:00:00.000Z");
	const rows = sources.forConversation("app/1");
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		skill: "herdr",
		conversationId: "app/1",
		kind: "turn",
		reviewId: "r2",
		firstAt: "2026-10-16T00:00:00.000Z",
		lastAt: "2026-10-16T03:00:00.000Z",
	});
	// Another thread generating the same skill is its own row.
	sources.record("dm:1", "herdr", "reviewer");
	expect(sources.forConversation("dm:1")).toHaveLength(1);
	expect(sources.forConversation("app/1")).toHaveLength(1);
});

test("rows order by latest write, then name", () => {
	const { sources } = fixture();
	sources.record("app/1", "b-skill", "reviewer", "2026-10-16T01:00:00.000Z");
	sources.record("app/1", "a-skill", "reviewer", "2026-10-16T02:00:00.000Z");
	sources.record("app/1", "c-skill", "turn", "2026-10-16T03:00:00.000Z");
	expect(sources.forConversation("app/1").map((r) => r.skill)).toEqual([
		"c-skill",
		"a-skill",
		"b-skill",
	]);
});

test("rejects names outside the catalog rule", () => {
	const { sources } = fixture();
	expect(() => sources.record("app/1", "../escape", "turn")).toThrow();
	expect(() => sources.record("app/1", "UPPER", "turn")).toThrow();
	expect(() => sources.record("app/1", "a--b", "turn")).toThrow();
	expect(() => sources.record("app/1", "-lead", "turn")).toThrow();
	expect(sources.forConversation("app/1")).toEqual([]);
});

test("backfill rows never rewind live writes — only the earlier first_at survives", () => {
	const { sources } = fixture();
	// A live turn write at 05:00, then the log backfill claims a review
	// at 03:00 and a rerun replays 03:00: kind and last_at stay live,
	// first_at keeps the earliest evidence.
	sources.record("app/1", "herdr", "turn", "2026-10-16T05:00:00.000Z");
	sources.recordInitial("app/1", "herdr", "2026-10-16T03:00:00.000Z", "r1");
	sources.recordInitial("app/1", "herdr", "2026-10-16T03:00:00.000Z", "r1");
	expect(sources.forConversation("app/1")).toMatchObject([
		{
			skill: "herdr",
			kind: "turn",
			reviewId: null,
			firstAt: "2026-10-16T03:00:00.000Z",
			lastAt: "2026-10-16T05:00:00.000Z",
		},
	]);
});

for (const hours of [
	["01", "03"],
	["03", "01"],
] as const) {
	test(`backfill keeps earliest and latest historical proposals in ${hours.join(",")} order`, () => {
		const { sources } = fixture();
		for (const hour of [...hours, ...hours]) {
			sources.recordInitial("app/1", "herdr", `2026-10-16T${hour}:00:00.000Z`, `r-${hour}`);
		}
		expect(sources.forConversation("app/1")).toMatchObject([
			{
				skill: "herdr",
				kind: "reviewer",
				reviewId: "r-03",
				firstAt: "2026-10-16T01:00:00.000Z",
				lastAt: "2026-10-16T03:00:00.000Z",
			},
		]);
	});
}

test("backfill does not replace live authorship at an equal timestamp", () => {
	const { sources } = fixture();
	const at = "2026-10-16T03:00:00.000Z";
	sources.record("app/1", "herdr", "turn", at);
	sources.recordInitial("app/1", "herdr", at, "r-old");
	expect(sources.forConversation("app/1")[0]).toMatchObject({
		kind: "turn",
		reviewId: null,
		firstAt: at,
		lastAt: at,
	});
});

test("live state resolves from the filesystem", () => {
	const { workspace } = fixture();
	const skillsDir = join(workspace, "skills");
	const proposedDir = join(workspace, "skills-proposed");
	const state = (skill: string) => liveStateOf(skillDiskPresence(skillsDir, proposedDir, skill));
	expect(state("nope")).toBe("gone");
	mkdirSync(join(proposedDir, "staged"));
	expect(state("staged")).toBe("proposed");
	mkdirSync(join(skillsDir, "staged"));
	// Installed wins over proposed — approval is a move, but a stray
	// copy must not render as "merely proposed".
	expect(state("staged")).toBe("installed");
});

test("disk presence keeps both facts — an installed skill can carry a pending proposal", () => {
	const { workspace } = fixture();
	const skillsDir = join(workspace, "skills");
	const proposedDir = join(workspace, "skills-proposed");
	expect(skillDiskPresence(skillsDir, proposedDir, "nope")).toEqual({
		installed: false,
		proposed: false,
	});
	mkdirSync(join(proposedDir, "staged"));
	expect(skillDiskPresence(skillsDir, proposedDir, "staged")).toEqual({
		installed: false,
		proposed: true,
	});
	mkdirSync(join(skillsDir, "staged"));
	// An update proposal parked on a live skill — the presence answer
	// keeps both bits where liveStateOf collapses to installed.
	expect(skillDiskPresence(skillsDir, proposedDir, "staged")).toEqual({
		installed: true,
		proposed: true,
	});
	expect(liveStateOf(skillDiskPresence(skillsDir, proposedDir, "staged"))).toBe("installed");
});

for (const catalog of ["skills", "skills-proposed"]) {
	test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
		`live state propagates EACCES from ${catalog}`,
		() => {
			const { workspace } = fixture();
			const dir = join(workspace, catalog);
			mkdirSync(join(dir, "blocked"));
			chmodSync(dir, 0);
			try {
				expect(() =>
					skillDiskPresence(join(workspace, "skills"), join(workspace, "skills-proposed"), "blocked"),
				).toThrow(expect.objectContaining({ code: "EACCES", path: join(dir, "blocked") }));
			} finally {
				chmodSync(dir, 0o755);
			}
		},
	);

	test(`live state propagates symlink loops from ${catalog}`, () => {
		const { workspace } = fixture();
		symlinkSync("loop", join(workspace, catalog, "loop"));
		expect(() =>
			skillDiskPresence(join(workspace, "skills"), join(workspace, "skills-proposed"), "loop"),
		).toThrow(expect.objectContaining({ code: "ELOOP" }));
	});
}

test("live state propagates ENOTDIR instead of declaring a broken catalog gone", () => {
	const { workspace } = fixture();
	const file = join(workspace, "not-a-directory");
	writeFileSync(file, "occupied");
	expect(() => skillDiskPresence(file, join(workspace, "skills-proposed"), "missing")).toThrow(
		expect.objectContaining({ code: "ENOTDIR" }),
	);
});
