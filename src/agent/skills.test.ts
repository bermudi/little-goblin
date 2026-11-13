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
	test("missing dir is an empty catalog that still names its root", () => {
		expect(loadCatalog(join(useRoot(), "nope"))).toEqual({
			entries: [],
			skipped: [],
			root: "nope",
		});
	});

	test("a valid skill is listed", () => {
		const root = useRoot();
		writeSkill(root, "mq", "name: mq\ndescription: jq for Markdown");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([
			{ name: "mq", description: "jq for Markdown", path: join("skills", "mq", "SKILL.md") },
		]);
		expect(catalog.skipped).toHaveLength(0);
		expect(catalog.root).toBe("skills");
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
		expect(catalog.skipped).toHaveLength(0);
		expect(catalog.entries[0]!.name).toBe("browser");
		// The bare-string form stays accepted too.
		writeSkill(root, "mq", 'name: mq\ndescription: d\nallowed-tools: "Bash(mq:*)"');
		expect(loadCatalog(root).skipped).toHaveLength(0);
	});

	test("a directory without SKILL.md is skipped; loose files are ignored", () => {
		const root = useRoot();
		mkdirSync(join(root, "empty"), { recursive: true });
		writeFileSync(join(root, "README.md"), "not a skill");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toHaveLength(1); // only the SKILL.md-less dir counts
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
		expect(catalog.skipped).toHaveLength(1);
	});

	test("frontmatter name must equal the directory name", () => {
		const root = useRoot();
		writeSkill(root, "link-name", "name: other-name\ndescription: d");
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toHaveLength(1);
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
		expect(catalog.skipped).toHaveLength(5);
	});

	test("missing or oversized description is skipped", () => {
		const root = useRoot();
		writeSkill(root, "nodesc", "name: nodesc");
		writeSkill(root, "bigdesc", `name: bigdesc\ndescription: ${"d".repeat(1025)}`);
		const catalog = loadCatalog(root);
		expect(catalog.entries).toEqual([]);
		expect(catalog.skipped).toHaveLength(2);
	});

	test("disable-model-invocation rides the catalog but not the prompt section", () => {
		const root = useRoot();
		writeSkill(root, "manual", "name: manual\ndescription: d\ndisable-model-invocation: true");
		writeSkill(root, "auto", "name: auto\ndescription: d\ndisable-model-invocation: false");
		const catalog = loadCatalog(root);
		expect(catalog.entries.map((e) => e.name)).toEqual(["auto", "manual"]);
		expect(catalog.entries.find((e) => e.name === "manual")?.manualOnly).toBe(true);
		expect(catalog.entries.find((e) => e.name === "auto")?.manualOnly).toBeUndefined();
		expect(catalog.skipped).toHaveLength(0);
		// The prompt section never learns a manual-only name.
		const lines = formatSkillsSection(catalog).join("\n");
		expect(lines).toContain("- auto — d");
		expect(lines).not.toContain("manual");
	});

	test("an all-manual catalog renders none-yet, not a lie", () => {
		const root = useRoot();
		writeSkill(root, "manual", "name: manual\ndescription: d\ndisable-model-invocation: true");
		const lines = formatSkillsSection(loadCatalog(root)).join("\n");
		expect(lines).toContain("(none yet)");
		expect(lines).not.toContain("manual");
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
		expect(catalog.skipped).toHaveLength(2);
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
		expect(catalog.skipped).toHaveLength(3);
	});

	// Regression (#484): the spec's `metadata` map is open — openclaw
	// carries a nested object, hermes carries lists under `hermes:`.
	// Frontmatter shapes below copy the real ecosystem files.
	test("an openclaw-shaped skill with nested-object metadata joins the catalog", () => {
		const root = useRoot();
		writeSkill(
			root,
			"1password",
			[
				'name: 1password',
				'description: "Set up and use 1Password CLI for sign-in and reading secrets."',
				"homepage: https://developer.1password.com/docs/cli/get-started/",
				"metadata:",
				"  {",
				'    "openclaw":',
				"      {",
				'        "emoji": "🔐",',
				'        "requires": { "bins": ["op"] },',
				'        "install":',
				"          [",
				"            {",
				'              "id": "brew",',
				'              "kind": "brew",',
				'              "formula": "1password-cli",',
				'              "bins": ["op"],',
				'              "label": "Install 1Password CLI (brew)",',
				"            },",
				"          ],",
				"      },",
				"  }",
			].join("\n"),
		);
		const catalog = loadCatalog(root);
		expect(catalog.skipped).toHaveLength(0);
		expect(catalog.entries.map((e) => e.name)).toEqual(["1password"]);
		expect(formatSkillsSection(catalog).join("\n")).toContain("- 1password —");
	});

	test("a hermes-shaped skill with list-valued metadata joins the catalog", () => {
		const root = useRoot();
		writeSkill(
			root,
			"agent-merge-conflict-arbiter",
			[
				"name: agent-merge-conflict-arbiter",
				'description: "Neutral arbiter for merge conflicts between two agents."',
				"version: 1.0.0",
				"author: Hermes Agent",
				"license: MIT",
				"platforms: [linux, macos, windows]",
				"metadata:",
				"  hermes:",
				"    tags: [Multi-Agent, Git, Merge-Conflict, Kanban, Arbitration]",
				"    related_skills: [hermes-agent]",
			].join("\n"),
		);
		const catalog = loadCatalog(root);
		expect(catalog.skipped).toHaveLength(0);
		expect(catalog.entries.map((e) => e.name)).toEqual(["agent-merge-conflict-arbiter"]);
	});

	test("a malformed skill's dir and reason name it in the prompt section", () => {
		const root = useRoot();
		writeSkill(root, "noname", "description: no name field");
		const catalog = loadCatalog(root);
		expect(catalog.skipped).toEqual([
			{ dir: "noname", reason: "name: Invalid input: expected string, received undefined" },
		]);
		const lines = formatSkillsSection(catalog).join("\n");
		expect(lines).toContain("(1 entry skipped as malformed");
		expect(lines).toContain(
			"- noname — name: Invalid input: expected string, received undefined",
		);
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
		const text = formatSkillsSection({ entries: [], skipped: [], root: "skills" }).join("\n");
		expect(text).toContain("## skills");
		expect(text).toContain("(none yet)");
	});

	test("the default header is byte-for-byte the shipped text", () => {
		expect(formatSkillsSection({ entries: [], skipped: [], root: "skills" })).toEqual([
			"## skills",
			"",
			"Skills are directories under `skills/` — each a SKILL.md (frontmatter:",
			"name, description) with instructions plus any scripts/files it needs.",
			"When a request matches one, read_file its SKILL.md and follow it. Write",
			"or edit skills only when the operator asks — never create or rewrite",
			"one on your own initiative: if the skill reviewer is configured, lessons",
			"become drafts for review. An asked-for write goes to",
			"skills/<name>/SKILL.md, then `skills-ref validate ./skills/<name>` via bash.",
			"Edits load when the next conversation starts.",
			"",
			"(none yet)",
		]);
	});

	test("a link base renders every path absolute", () => {
		expect(
			formatSkillsSection(
				{
					entries: [{ name: "mq", description: "jq for Markdown", path: "skills/mq/SKILL.md" }],
					skipped: [],
					root: "skills",
				},
				undefined,
				"/global/workspace",
			),
		).toEqual([
			"## skills",
			"",
			"Skills are directories under `/global/workspace/skills/` — each a SKILL.md (frontmatter:",
			"name, description) with instructions plus any scripts/files it needs.",
			"When a request matches one, read_file its SKILL.md and follow it. Write",
			"or edit skills only when the operator asks — never create or rewrite",
			"one on your own initiative: if the skill reviewer is configured, lessons",
			"become drafts for review. An asked-for write goes to",
			"/global/workspace/skills/<name>/SKILL.md, then `skills-ref validate '/global/workspace/skills/<name>'` via bash.",
			"Edits load when the next conversation starts.",
			"",
			"- mq — jq for Markdown (/global/workspace/skills/mq/SKILL.md)",
		]);
	});

	test("a link base with a space and apostrophe still shell-quotes the validate path", () => {
		expect(
			formatSkillsSection(
				{
					entries: [{ name: "mq", description: "jq for Markdown", path: "skills/mq/SKILL.md" }],
					skipped: [],
					root: "skills",
				},
				undefined,
				"/tmp/operator's workspace",
			),
		).toEqual([
			"## skills",
			"",
			"Skills are directories under `/tmp/operator's workspace/skills/` — each a SKILL.md (frontmatter:",
			"name, description) with instructions plus any scripts/files it needs.",
			"When a request matches one, read_file its SKILL.md and follow it. Write",
			"or edit skills only when the operator asks — never create or rewrite",
			"one on your own initiative: if the skill reviewer is configured, lessons",
			"become drafts for review. An asked-for write goes to",
			"/tmp/operator's workspace/skills/<name>/SKILL.md, then `skills-ref validate '/tmp/operator'\\''s workspace/skills/<name>'` via bash.",
			"Edits load when the next conversation starts.",
			"",
			"- mq — jq for Markdown (/tmp/operator's workspace/skills/mq/SKILL.md)",
		]);
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
			skipped: [],
			root: "skills",
		}).join("\n");
		expect(text).toContain("- mq — jq for Markdown [Requires the mq CLI] (skills/mq/SKILL.md)");
	});

	test("the skip count and per-entry reasons render for the agent to surface", () => {
		const one = formatSkillsSection({
			entries: [],
			skipped: [{ dir: "bad", reason: "name: Invalid input" }],
			root: "skills",
		}).join("\n");
		expect(one).toContain("(1 entry skipped as malformed");
		expect(one).toContain("- bad — name: Invalid input");
		const many = formatSkillsSection({
			entries: [],
			skipped: [
				{ dir: "a", reason: "no SKILL.md" },
				{ dir: "b", reason: "unterminated frontmatter" },
				{ dir: "c", reason: "description: Invalid input" },
			],
			root: "skills",
		}).join("\n");
		expect(many).toContain("(3 entries skipped as malformed");
		expect(many).toContain("- a — no SKILL.md");
		expect(many).toContain("- c — description: Invalid input");
	});

	test("pending proposals render when present — and only then", () => {
		const none = formatSkillsSection(
			{ entries: [], skipped: [], root: "skills" },
			{ entries: [], skipped: [], root: "skills-proposed" },
		).join("\n");
		expect(none).not.toContain("Pending proposals");
		const absent = formatSkillsSection({ entries: [], skipped: [], root: "skills" }).join("\n");
		expect(absent).not.toContain("Pending proposals");
		const withProposal = formatSkillsSection(
			{ entries: [], skipped: [], root: "skills" },
			{
				entries: [
					{
						name: "pdf-tables",
						description: "Extract tables from PDFs",
						path: "skills-proposed/pdf-tables/SKILL.md",
					},
				],
				skipped: [],
				root: "skills-proposed",
			},
		).join("\n");
		expect(withProposal).toContain("Pending proposals");
		expect(withProposal).toContain("NOT installed");
		expect(withProposal).toContain(
			"- pdf-tables — Extract tables from PDFs (skills-proposed/pdf-tables/SKILL.md)",
		);
	});

	test("the prose derives its roots from the scanned catalogs, not a hardcoded leaf", () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-skills-"));
		dirs.push(dir);
		const root = join(dir, "my-catalog");
		writeSkill(root, "mq", "name: mq\ndescription: jq for Markdown");
		writeSkill(join(dir, "drafts"), "pdf", "name: pdf\ndescription: Extract PDF text");
		const catalog = loadCatalog(root);
		const proposals = loadCatalog(join(dir, "drafts"));
		const text = formatSkillsSection(catalog, proposals).join("\n");
		expect(text).toContain("Skills are directories under `my-catalog/`");
		expect(text).toContain("write goes to\nmy-catalog/<name>/SKILL.md");
		expect(text).toContain("`skills-ref validate ./my-catalog/<name>` via bash");
		expect(text).toContain("- mq — jq for Markdown (my-catalog/mq/SKILL.md)");
		expect(text).toContain("reviewer drafts under `drafts/`");
		expect(text).toContain("- pdf — Extract PDF text (drafts/pdf/SKILL.md)");
		// Entries and prose share the root's basename — they can't disagree.
		expect(catalog.entries[0]!.path).toBe("my-catalog/mq/SKILL.md");
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
		expect(catalog.skipped).toHaveLength(1);
	});
});
