import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsSection, loadCatalog } from "./skills.ts";

let dirs: string[] = [];

function useRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-skills-"));
	dirs.push(dir);
	return join(dir, "skills");
}

function writeSkill(root: string, name: string, frontmatter: string, body = "body\n"): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("loadCatalog", () => {
	test("missing dir is an empty catalog", () => {
		expect(loadCatalog(join(useRoot(), "nope"))).toEqual({ entries: [], skipped: 0 });
	});

	test("a valid skill is listed", () => {
		const root = useRoot();
		writeSkill(root, "mq", "name: mq\ndescription: jq for Markdown");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([
			{ name: "mq", description: "jq for Markdown", path: join("skills", "mq", "SKILL.md") },
		]);
		expect(catalog.skipped).toBe(0);
	});

	test("entries sort by name", () => {
		const root = useRoot();
		writeSkill(root, "zed", "name: zed\ndescription: last");
		writeSkill(root, "abc", "name: abc\ndescription: first");
		expect(loadCatalog(root).entries.map((e) => e.name)).toEqual(["abc", "zed"]);
	});

	test("compatibility joins the entry", () => {
		const root = useRoot();
		writeSkill(root, "mq", "name: mq\ndescription: d\ncompatibility: Requires the mq CLI");
		expect(loadCatalog(root).entries[0]!.compatibility).toBe("Requires the mq CLI");
	});

	// Regression: the spec's own allowed-tools shape (a LIST) was rejected
	// by a string-only schema, silently dropping real skills — the live
	// browser skill never made it into the catalog until this was caught.
	test("spec-shaped allowed-tools (a list) parses and lists the skill", () => {
		const root = useRoot();
		writeSkill(
			root,
			"browser",
			"name: browser\ndescription: drive Chrome\nallowed-tools:\n  - Bash(agent-browser:*)",
		);
		const catalog = loadCatalog(root);
		expect(catalog.skipped).toBe(0);
		expect(catalog.entries[0]!.name).toBe("browser");
		// The bare-string form stays accepted too.
		writeSkill(root, "mq", 'name: mq\ndescription: d\nallowed-tools: "Bash(mq:*)"');
		expect(loadCatalog(root).skipped).toBe(0);
	});

	test("a directory without SKILL.md is skipped; loose files are ignored", () => {
		const root = useRoot();
		mkdirSync(join(root, "empty"), { recursive: true });
		writeFileSync(join(root, "README.md"), "not a skill");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(1); // only the SKILL.md-less dir counts
	});

	test("a symlinked directory resolves; a broken link is skipped", () => {
		const root = useRoot();
		mkdirSync(root, { recursive: true });
		const target = mkdtempSync(join(tmpdir(), "goblin-skill-src-"));
		dirs.push(target);
		writeSkill(target, "mq", "name: mq\ndescription: jq for Markdown");
		symlinkSync(join(target, "mq"), join(root, "mq"));
		symlinkSync(join(root, "gone"), join(root, "dangling"));
		const catalog = loadCatalog(root);
		expect(catalog.entries.map((e) => e.name)).toEqual(["mq"]);
		expect(catalog.skipped).toBe(1);
	});

	test("frontmatter name must equal the directory name", () => {
		const root = useRoot();
		writeSkill(root, "link-name", "name: other-name\ndescription: d");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(1);
	});

	test("spec-invalid names are skipped", () => {
		const root = useRoot();
		for (const [dir, name] of [
			["upper", "Upper"],
			["lead", "-lead"],
			["trail", "trail-"],
			["dbl", "d--b"],
			["long", `a${"b".repeat(64)}`],
		] as const) {
			writeSkill(root, dir, `name: ${name}\ndescription: d`);
		}
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(5);
	});

	test("missing or oversized description is skipped", () => {
		const root = useRoot();
		writeSkill(root, "nodesc", "name: nodesc");
		writeSkill(root, "bigdesc", `name: bigdesc\ndescription: ${"d".repeat(1025)}`);
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(2);
	});

	test("disable-model-invocation stays unlisted but is not malformed", () => {
		const root = useRoot();
		writeSkill(root, "manual", "name: manual\ndescription: d\ndisable-model-invocation: true");
		writeSkill(root, "auto", "name: auto\ndescription: d\ndisable-model-invocation: false");
		const catalog = loadCatalog(root);
		expect(catalog.entries.map((e) => e.name)).toEqual(["auto"]);
		expect(catalog.skipped).toBe(0);
	});

	test("unknown frontmatter keys pass through", () => {
		const root = useRoot();
		writeSkill(root, "mq", "name: mq\ndescription: d\nexplicitly: local\ntopic: md");
		expect(loadCatalog(root).entries).toHaveLength(1);
	});

	test("badly-shaped optional fields are skipped", () => {
		const root = useRoot();
		writeSkill(root, "badmeta", "name: badmeta\ndescription: d\nmetadata: 5");
		writeSkill(
			root,
			"bigcompat",
			`name: bigcompat\ndescription: d\ncompatibility: ${"c".repeat(501)}`,
		);
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(2);
	});

	test("missing, unterminated, or invalid frontmatter is skipped", () => {
		const root = useRoot();
		mkdirSync(join(root, "nofm"), { recursive: true });
		writeFileSync(join(root, "nofm", "SKILL.md"), "# just markdown\n");
		mkdirSync(join(root, "unterm"), { recursive: true });
		writeFileSync(join(root, "unterm", "SKILL.md"), "---\nname: unterm\ndescription: d\n");
		mkdirSync(join(root, "badyaml"), { recursive: true });
		writeFileSync(join(root, "badyaml", "SKILL.md"), "---\n: : :\n---\n");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(3);
	});

	test("the catalog caps at 128 entries", () => {
		const root = useRoot();
		for (let i = 0; i < 130; i++) {
			const name = `s${String(i).padStart(3, "0")}`;
			writeSkill(root, name, `name: ${name}\ndescription: d`);
		}
		const catalog = loadCatalog(root);
		expect(catalog.entries).toHaveLength(128);
		expect(catalog.entries[127]!.name).toBe("s127");
	});
});

describe("formatSkillsSection", () => {
	test("an empty catalog still renders the capability notice", () => {
		const text = formatSkillsSection({ entries: [], skipped: 0 }).join("\n");
		expect(text).toContain("## skills");
		expect(text).toContain("(none yet)");
	});

	test("entries list name, description, compatibility, and path", () => {
		const text = formatSkillsSection({
			entries: [
				{
					name: "mq",
					description: "jq for Markdown",
					compatibility: "Requires the mq CLI",
					path: "skills/mq/SKILL.md",
				},
			],
			skipped: 0,
		}).join("\n");
		expect(text).toContain("- mq — jq for Markdown [Requires the mq CLI] (skills/mq/SKILL.md)");
	});

	test("the skip count is noted for the agent to surface", () => {
		const one = formatSkillsSection({ entries: [], skipped: 1 }).join("\n");
		expect(one).toContain("(1 entry skipped as malformed");
		const many = formatSkillsSection({ entries: [], skipped: 3 }).join("\n");
		expect(many).toContain("(3 entries skipped as malformed");
	});

	test("frontmatter that doesn't close inside the 16 KiB head is malformed", () => {
		const root = useRoot();
		const dir = join(root, "huge");
		mkdirSync(dir, { recursive: true });
		// The closing --- sits past the bounded head — the read truncates
		// before it, so the frontmatter is unterminated, not large.
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\n# ${"a".repeat(17 * 1024)}\n---\nname: huge\ndescription: d\nbody\n`,
		);
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toBe(1);
	});
});
