import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { attributedSkills, type SkillWatch } from "./skill-attribution.ts";

const ROOT = "/ws";
const watch: SkillWatch = {
	skillsDir: join(ROOT, "skills"),
	proposedDir: join(ROOT, "skills-proposed"),
	record: () => {},
};

describe("skill attribution (exact paths only)", () => {
	test("write_file/edit_file outputs under the catalog attribute their skill dir", () => {
		expect(
			attributedSkills(watch, "write_file", {
				path: join(ROOT, "skills/herdr/SKILL.md"),
				bytes: 10,
			}),
		).toEqual(["herdr"]);
		expect(
			attributedSkills(watch, "edit_file", {
				path: join(ROOT, "skills-proposed/open-source-check/SKILL.md"),
				replaced: 1,
			}),
		).toEqual(["open-source-check"]);
	});

	test("writes outside the catalog, bare root files, and invalid names attribute nothing", () => {
		// A project conversation's own skills/ dir — not the catalog.
		expect(
			attributedSkills(watch, "write_file", { path: "/proj/skills/foo/SKILL.md", bytes: 1 }),
		).toEqual([]);
		// The catalog root itself is not a skill.
		expect(
			attributedSkills(watch, "write_file", { path: join(ROOT, "skills/notes"), bytes: 1 }),
		).toEqual([]);
		// Names outside the catalog rule are not skills.
		expect(
			attributedSkills(watch, "write_file", {
				path: join(ROOT, "skills/NotASkill/SKILL.md"),
				bytes: 1,
			}),
		).toEqual([]);
	});

	test("soft-failed calls carry no path and attribute nothing", () => {
		expect(attributedSkills(watch, "edit_file", { error: "old_string not found in x" })).toEqual(
			[],
		);
		expect(attributedSkills(watch, "write_file", { error: "dangling symlink" })).toEqual([]);
	});

	test("a script's nested file writes attribute; failed and cut records do not", () => {
		const out = {
			text: "ok",
			calls: [
				{
					tool: "write_file",
					args: '{"path":"skills/new-skill/SKILL.md"}',
					ok: true,
					result: `{"path":"${join(ROOT, "skills/new-skill/SKILL.md")}","bytes":40}`,
				},
				{
					tool: "edit_file",
					args: '{"path":"skills/new-skill/SKILL.md"}',
					ok: false,
					result: '{"error":"old_string not found"}',
				},
				{
					tool: "write_file",
					args: '{"path":"skills/cut-skill/SKILL.md","content":"aaaaaaaaaa',
					ok: true,
					result: '{"path":"/ws/skills/cut-sk', // truncated by summarize
				},
			],
		};
		expect(attributedSkills(watch, "script", out)).toEqual(["new-skill"]);
	});

	test("bash is never scanned — approvals move dirs through it", () => {
		expect(attributedSkills(watch, "bash", { output: `mv skills-proposed/x skills/x` })).toEqual(
			[],
		);
	});
});
