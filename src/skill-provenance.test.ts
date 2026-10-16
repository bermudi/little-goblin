import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import { SkillSources, skillLiveState } from "./skill-provenance.ts";

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
	expect(sources.isEmpty()).toBe(true);
});

test("live state resolves from the filesystem", () => {
	const { sources, workspace } = fixture();
	const skillsDir = join(workspace, "skills");
	const proposedDir = join(workspace, "skills-proposed");
	expect(skillLiveState(skillsDir, proposedDir, "nope")).toBe("gone");
	mkdirSync(join(proposedDir, "staged"));
	expect(skillLiveState(skillsDir, proposedDir, "staged")).toBe("proposed");
	mkdirSync(join(skillsDir, "staged"));
	// Installed wins over proposed — approval is a move, but a stray
	// copy must not render as "merely proposed".
	expect(skillLiveState(skillsDir, proposedDir, "staged")).toBe("installed");
});
