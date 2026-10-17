// The shared approve/discard mechanics every door runs
// (design/skills.md → "It proposes, then tells"). The Telegram tap
// handler's stamps/answers are covered in tg/skill-approval.test.ts;
// these pin the disk moves' own contract plus resolveSkillProposal's
// provenance → history flow that the operator doors ride.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UIMessage } from "ai";
import {
	decideSkillProposal,
	resolveSkillProposal,
	skillResolutionText,
} from "./skill-decisions.ts";
import { tmpDir } from "./testkit.ts";

function fixture(): {
	workspaceDir: string;
	skillsDir: string;
	proposedDir: string;
} {
	const workspaceDir = tmpDir("goblin-skilldec-");
	const skillsDir = join(workspaceDir, "skills");
	const proposedDir = join(workspaceDir, "skills-proposed");
	mkdirSync(join(proposedDir, "smoke-test"), { recursive: true });
	writeFileSync(join(proposedDir, "smoke-test", "SKILL.md"), "# smoke");
	return { workspaceDir, skillsDir, proposedDir };
}

function row(skill = "smoke-test", conversationId = "app/abc") {
	return {
		skill,
		conversationId,
		kind: "reviewer" as const,
		reviewId: null,
		firstAt: "2026-10-17T00:00:00Z",
		lastAt: "2026-10-17T00:00:00Z",
	};
}

describe("decideSkillProposal", () => {
	test("install swaps the proposal into skills/", () => {
		const dirs = fixture();
		const d = decideSkillProposal(dirs, "smoke-test", "install");
		expect(d).toEqual({ action: "install", ok: true, replaced: false });
		expect(existsSync(join(dirs.skillsDir, "smoke-test", "SKILL.md"))).toBe(true);
		expect(existsSync(join(dirs.proposedDir, "smoke-test"))).toBe(false);
	});

	test("install over a live copy reports the replace and swaps content", () => {
		const dirs = fixture();
		mkdirSync(join(dirs.skillsDir, "smoke-test"), { recursive: true });
		writeFileSync(join(dirs.skillsDir, "smoke-test", "SKILL.md"), "# old");
		const d = decideSkillProposal(dirs, "smoke-test", "install");
		expect(d).toEqual({ action: "install", ok: true, replaced: true });
	});

	test("discard deletes the staged dir", () => {
		const dirs = fixture();
		const d = decideSkillProposal(dirs, "smoke-test", "discard");
		expect(d).toEqual({ action: "discard", ok: true });
		expect(existsSync(join(dirs.proposedDir, "smoke-test"))).toBe(false);
	});

	test("a gone proposal answers gone — no throw, no mutation", () => {
		const dirs = fixture();
		const d = decideSkillProposal(dirs, "vanished", "install");
		expect(d).toEqual({ action: "install", ok: false, reason: "gone" });
	});

	test("a symlinked proposal is refused — operator state, not a skill", () => {
		const dirs = fixture();
		mkdirSync(join(dirs.workspaceDir, "real"), { recursive: true });
		symlinkSync(
			join(dirs.workspaceDir, "real"),
			join(dirs.proposedDir, "linked"),
			"dir",
		);
		const d = decideSkillProposal(dirs, "linked", "discard");
		expect(d).toEqual({ action: "discard", ok: false, reason: "proposal dir is a symlink" });
		expect(existsSync(join(dirs.proposedDir, "linked"))).toBe(true);
	});
});

describe("resolveSkillProposal", () => {
	function recordedStore() {
		const appended: { conversation: string; text: string }[] = [];
		return {
			appended,
			append(id: string, messages: UIMessage[]) {
				appended.push({
					conversation: id,
					text: (messages[0]!.parts[0] as { text: string }).text,
				});
			},
		};
	}

	test("an install appends the resolution to the learning conversation", () => {
		const dirs = fixture();
		const store = recordedStore();
		const d = resolveSkillProposal(
			{
				...dirs,
				forSkill: () => [row()],
				store,
			},
			"smoke-test",
			"install",
		);
		expect(d.ok).toBe(true);
		expect(store.appended).toEqual([
			{ conversation: "app/abc", text: "skill proposal resolved: smoke-test — installed" },
		]);
	});

	test("a discard records the deletion wording in history", () => {
		const dirs = fixture();
		const store = recordedStore();
		resolveSkillProposal({ ...dirs, forSkill: () => [row()], store }, "smoke-test", "discard");
		expect(store.appended[0]!.text).toBe(
			"skill proposal resolved: smoke-test — discarded (deleted)",
		);
	});

	test("no provenance row — the decision still lands, nothing appended", () => {
		const dirs = fixture();
		const store = recordedStore();
		const d = resolveSkillProposal(
			{ ...dirs, forSkill: () => [], store },
			"smoke-test",
			"discard",
		);
		expect(d.ok).toBe(true);
		expect(existsSync(join(dirs.proposedDir, "smoke-test"))).toBe(false);
		expect(store.appended).toEqual([]);
	});

	test("a failed decision never writes history", () => {
		const dirs = fixture();
		const store = recordedStore();
		const d = resolveSkillProposal(
			{ ...dirs, forSkill: () => [row()], store },
			"vanished",
			"install",
		);
		expect(d).toEqual({ action: "install", ok: false, reason: "gone" });
		expect(store.appended).toEqual([]);
	});

	test("no store seam — decides and logs, history skipped", () => {
		const dirs = fixture();
		const d = resolveSkillProposal(
			{ ...dirs, forSkill: () => [row()] },
			"smoke-test",
			"discard",
		);
		expect(d.ok).toBe(true);
	});
});

describe("skillResolutionText", () => {
	test("install wording carries the replace note only when it happened", () => {
		expect(
			skillResolutionText({ action: "install", ok: true, replaced: false }, "x"),
		).toBe("skill proposal resolved: x — installed");
		expect(skillResolutionText({ action: "install", ok: true, replaced: true }, "x")).toBe(
			"skill proposal resolved: x — installed (replaced live copy)",
		);
		expect(skillResolutionText({ action: "discard", ok: true }, "x")).toBe(
			"skill proposal resolved: x — discarded (deleted)",
		);
	});
});
