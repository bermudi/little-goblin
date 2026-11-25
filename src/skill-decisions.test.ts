// The shared approve/discard mechanics every door runs. The Telegram
// tap handler's stamps/answers live in tg/skill-approval.test.ts; these
// pin the disk moves' own contract plus resolveSkillProposal's
// provenance → history flow.

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "./message.ts";
import {
	decideSkillProposal,
	discardedRoot,
	proposalFingerprint,
	resolveSkillProposal,
	skillResolutionText,
} from "./skill-decisions.ts";
import { loadCatalog } from "./agent/skills.ts";
import { listSkills } from "./stateview.ts";
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

	test("discard keeps the draft under its exact timestamped name", () => {
		const dirs = fixture();
		const original = readFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"));
		const now = () => new Date("2026-11-25T14:03:04.567Z");
		const d = decideSkillProposal({ ...dirs, now }, "smoke-test", "discard");
		expect(d).toEqual({ action: "discard", ok: true });
		expect(existsSync(join(dirs.proposedDir, "smoke-test"))).toBe(false);
		expect(existsSync(join(discardedRoot(dirs.workspaceDir), "smoke-test.2026-11-25T14-03-04-567Z"))).toBe(true);
		expect(
			readFileSync(
				join(discardedRoot(dirs.workspaceDir), "smoke-test.2026-11-25T14-03-04-567Z", "SKILL.md"),
			),
		).toEqual(original);
	});

	test("discard preserves nested files and relative symlinks without following them", () => {
		const dirs = fixture();
		const proposal = join(dirs.proposedDir, "smoke-test");
		mkdirSync(join(proposal, "nested"), { recursive: true });
		writeFileSync(join(proposal, "nested", "data.txt"), "nested bytes");
		writeFileSync(join(proposal, "target.txt"), "target bytes");
		symlinkSync("target.txt", join(proposal, "relative-link"));
		const d = decideSkillProposal(
			{ ...dirs, now: () => new Date("2026-11-25T14:03:04.567Z") },
			"smoke-test",
			"discard",
		);
		expect(d).toEqual({ action: "discard", ok: true });
		const kept = join(discardedRoot(dirs.workspaceDir), "smoke-test.2026-11-25T14-03-04-567Z");
		expect(readFileSync(join(kept, "nested", "data.txt"), "utf8")).toBe("nested bytes");
		expect(lstatSync(join(kept, "relative-link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(kept, "relative-link"))).toBe("target.txt");
		expect(readFileSync(join(kept, "target.txt"), "utf8")).toBe("target bytes");
	});

	test("discards at different times keep both drafts with their own bytes", () => {
		const dirs = fixture();
		const now = () => new Date("2026-11-25T14:03:04.567Z");
		expect(decideSkillProposal({ ...dirs, now }, "smoke-test", "discard")).toEqual({
			action: "discard",
			ok: true,
		});
		mkdirSync(join(dirs.proposedDir, "smoke-test"));
		writeFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"), "# later");
		const later = () => new Date("2026-11-25T14:03:05.567Z");
		expect(decideSkillProposal({ ...dirs, now: later }, "smoke-test", "discard")).toEqual({
			action: "discard",
			ok: true,
		});
		expect(
			readFileSync(
				join(discardedRoot(dirs.workspaceDir), "smoke-test.2026-11-25T14-03-04-567Z", "SKILL.md"),
				"utf8",
			),
		).toBe("# smoke");
		expect(
			readFileSync(
				join(discardedRoot(dirs.workspaceDir), "smoke-test.2026-11-25T14-03-05-567Z", "SKILL.md"),
				"utf8",
			),
		).toBe("# later");
	});

	test("a same-time discard conflict keeps both the first copy and second proposal unchanged", () => {
		const dirs = fixture();
		const first = readFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"));
		const now = () => new Date("2026-11-25T14:03:04.567Z");
		expect(decideSkillProposal({ ...dirs, now }, "smoke-test", "discard")).toEqual({
			action: "discard",
			ok: true,
		});
		mkdirSync(join(dirs.proposedDir, "smoke-test"));
		writeFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"), "# second");
		const second = readFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"));
		expect(decideSkillProposal({ ...dirs, now }, "smoke-test", "discard")).toEqual({
			action: "discard",
			ok: false,
			reason: "discard target exists",
		});
		expect(
			readFileSync(
				join(discardedRoot(dirs.workspaceDir), "smoke-test.2026-11-25T14-03-04-567Z", "SKILL.md"),
			),
		).toEqual(first);
		expect(readFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"))).toEqual(second);
	});

	test("unsafe discarded roots refuse without changing the proposal or writing through a symlink", () => {
		for (const kind of ["symlink", "file"] as const) {
			const dirs = fixture();
			const original = readFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"));
			if (kind === "symlink") {
				const outside = join(dirs.workspaceDir, "outside");
				mkdirSync(outside);
				symlinkSync(outside, discardedRoot(dirs.workspaceDir), "dir");
			} else {
				writeFileSync(discardedRoot(dirs.workspaceDir), "sentinel");
			}
			const outcome = decideSkillProposal(
				{ ...dirs, now: () => new Date("2026-11-25T14:03:04.567Z") },
				"smoke-test",
				"discard",
			);
			expect(outcome).toEqual({
				action: "discard",
				ok: false,
				reason: kind === "symlink" ? "skills-discarded is a symlink" : "skills-discarded is not a directory",
			});
			expect(readFileSync(join(dirs.proposedDir, "smoke-test", "SKILL.md"))).toEqual(original);
			if (kind === "symlink") {
				expect(readdirSync(join(dirs.workspaceDir, "outside"))).toEqual([]);
			} else {
				expect(readFileSync(discardedRoot(dirs.workspaceDir), "utf8")).toBe("sentinel");
			}
		}
	});

	test("discarded drafts are absent from the installed and proposed listings and catalogs", () => {
		const dirs = fixture();
		expect(
			decideSkillProposal(
				{ ...dirs, now: () => new Date("2026-11-25T14:03:04.567Z") },
				"smoke-test",
				"discard",
			),
		).toEqual({ action: "discard", ok: true });
		expect(listSkills(dirs.skillsDir, dirs.proposedDir)).toMatchObject({
			skills: [],
			proposed: [],
			catalog: [],
		});
		expect(loadCatalog(dirs.skillsDir).entries).toEqual([]);
		expect(loadCatalog(dirs.proposedDir).entries).toEqual([]);
	});

	test("a gone proposal answers gone — no throw, no mutation", () => {
		const dirs = fixture();
		const d = decideSkillProposal(dirs, "vanished", "install");
		expect(d).toEqual({ action: "install", ok: false, reason: "gone" });
	});

	test("a symlinked proposal is refused — operator state, not a skill", () => {
		const dirs = fixture();
		mkdirSync(join(dirs.workspaceDir, "real"), { recursive: true });
		symlinkSync(join(dirs.workspaceDir, "real"), join(dirs.proposedDir, "linked"), "dir");
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
			append(id: string, messages: Message[]) {
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

	test("a discard records the resolution in history", () => {
		const dirs = fixture();
		const store = recordedStore();
		resolveSkillProposal({ ...dirs, forSkill: () => [row()], store }, "smoke-test", "discard");
		expect(store.appended[0]!.text).toBe(
			"skill proposal resolved: smoke-test — discarded",
		);
	});

	test("no provenance row — the decision still lands, nothing appended", () => {
		const dirs = fixture();
		const store = recordedStore();
		const d = resolveSkillProposal({ ...dirs, forSkill: () => [], store }, "smoke-test", "discard");
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
		const d = resolveSkillProposal({ ...dirs, forSkill: () => [row()] }, "smoke-test", "discard");
		expect(d.ok).toBe(true);
	});
});

describe("skillResolutionText", () => {
	test("install wording carries the replace note only when it happened", () => {
		expect(skillResolutionText({ action: "install", ok: true, replaced: false }, "x")).toBe(
			"skill proposal resolved: x — installed",
		);
		expect(skillResolutionText({ action: "install", ok: true, replaced: true }, "x")).toBe(
			"skill proposal resolved: x — installed (replaced live copy)",
		);
		expect(skillResolutionText({ action: "discard", ok: true }, "x")).toBe(
			"skill proposal resolved: x — discarded",
		);
	});
});

describe("proposalFingerprint", () => {
	test("retargeting a symlink changes the fingerprint", () => {
		const dir = tmpDir("fp-link-");
		mkdirSync(join(dir, "s"));
		const link = join(dir, "s", "SKILL.md");
		symlinkSync("/etc/hostname", link);
		const before = proposalFingerprint(dir, "s");
		rmSync(link);
		symlinkSync("/etc/hosts", link);
		expect(proposalFingerprint(dir, "s")).not.toBe(before);
	});
});
