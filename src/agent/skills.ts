// Skill catalog — scan workspace/skills/*/SKILL.md, validate frontmatter
// per the Agent Skills spec, and render the "## skills" prompt section.
// Rescanned every turn by buildSystemPrompt, so edits are live next
// message. A malformed entry warns and skips; it never kills a turn.
// See DESIGN.md "Skills" for the rulings.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { log } from "../log.ts";

// Frontmatter lives at the top of the file; a --- that doesn't close
// inside the head is malformed, not large.
const HEAD_BYTES = 16 * 1024;
// A self-authored catalog bigger than this is already a bug — cap and
// warn rather than stuff the prompt.
const MAX_ENTRIES = 128;

// Spec name rule: 1–64 chars, a-z0-9 and hyphens, no leading/trailing
// hyphen, no consecutive hyphens.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const frontmatterSchema = z.object({
	name: z.string().min(1).max(64),
	description: z.string().min(1).max(1024),
	license: z.string().optional(),
	compatibility: z.string().min(1).max(500).optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	"allowed-tools": z.string().optional(),
	// Non-spec extension the operator's catalog carries: manual-only
	// skills stay out of the advertised list.
	"disable-model-invocation": z.boolean().optional(),
});
// z.object strips unknown keys — real skills carry extra fields and
// that's tolerated, not an error.

type Frontmatter = z.infer<typeof frontmatterSchema>;

export interface SkillEntry {
	name: string;
	description: string;
	compatibility?: string;
	/** Path shown in the prompt — relative to the workspace. */
	path: string;
}

export interface SkillCatalog {
	entries: SkillEntry[];
	/** Entries skipped as malformed — each already log.warn'ed. */
	skipped: number;
}

// Bounded read of the file head — enough for frontmatter, never the body.
function readHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(HEAD_BYTES);
		const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

// Split and validate frontmatter. Returns the parsed frontmatter or a
// human-readable reason it's malformed.
function parseSkill(head: string): { fm: Frontmatter } | { err: string } {
	const firstBreak = head.indexOf("\n");
	const firstLine = firstBreak === -1 ? head : head.slice(0, firstBreak);
	if (firstLine.trim() !== "---") return { err: "missing frontmatter" };
	const rest = head.slice(firstBreak + 1);
	const close = rest.search(/^---[ \t]*$/m);
	if (close === -1) return { err: "unterminated frontmatter" };

	let raw: unknown;
	try {
		raw = Bun.YAML.parse(rest.slice(0, close));
	} catch (err) {
		return { err: `invalid YAML frontmatter: ${(err as Error).message}` };
	}
	const parsed = frontmatterSchema.safeParse(raw);
	if (!parsed.success) {
		return { err: z.prettifyError(parsed.error) };
	}
	const fm = parsed.data;
	if (!NAME_RE.test(fm.name)) {
		return { err: `invalid skill name ${JSON.stringify(fm.name)}` };
	}
	return { fm };
}

export function loadCatalog(root: string): SkillCatalog {
	let dirents;
	try {
		dirents = readdirSync(root, { withFileTypes: true });
	} catch (err) {
		// No catalog dir is an empty catalog, not an error.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], skipped: 0 };
		throw err;
	}

	const entries: SkillEntry[] = [];
	let skipped = 0;
	const skip = (path: string, reason: string) => {
		skipped++;
		log.warn("skill skipped", { path, reason });
	};

	for (const dirent of dirents) {
		const dir = join(root, dirent.name);
		let stats;
		try {
			// statSync follows symlinks — a linked-in skill resolves to its
			// target; a broken link throws and is skipped below.
			stats = statSync(dir);
		} catch (err) {
			skip(dir, `cannot stat: ${(err as Error).message}`);
			continue;
		}
		// Loose files in the root are not skills — ignored silently.
		if (!stats.isDirectory()) continue;

		const file = join(dir, "SKILL.md");
		let head: string;
		try {
			head = readHead(file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				skip(dir, "no SKILL.md");
				continue;
			}
			throw err;
		}
		const parsed = parseSkill(head);
		if ("err" in parsed) {
			skip(file, parsed.err);
			continue;
		}
		const fm = parsed.fm;
		// Spec: name must match the parent directory name — for a linked
		// skill that's the link's name, which is what the catalog shows.
		if (fm.name !== dirent.name) {
			skip(file, `name "${fm.name}" does not match directory "${dirent.name}"`);
			continue;
		}
		// Manual-only: valid but unadvertised. The operator can still name
		// it and the agent can ls + read the dir.
		if (fm["disable-model-invocation"] === true) continue;

		entries.push({
			name: fm.name,
			description: fm.description,
			...(fm.compatibility !== undefined ? { compatibility: fm.compatibility } : {}),
			path: join(basename(root), dirent.name, "SKILL.md"),
		});
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));
	if (entries.length > MAX_ENTRIES) {
		log.warn("skill catalog capped", {
			root,
			total: entries.length,
			kept: MAX_ENTRIES,
		});
		entries.length = MAX_ENTRIES;
	}
	return { entries, skipped };
}

// The prompt section. Renders even when empty — it's also the notice
// that the capability exists.
export function formatSkillsSection(catalog: SkillCatalog): string[] {
	const lines = [
		"## skills",
		"",
		"Skills are directories under `skills/` — each a SKILL.md (frontmatter:",
		"name, description) with instructions plus any scripts/files it needs.",
		"When a request matches one, read_file its SKILL.md and follow it. This",
		"catalog is yours: write skills/<name>/SKILL.md when you learn a",
		"repeatable task, then `skills-ref validate ./skills/<name>` via bash.",
		"Edits are live next turn.",
		"",
	];
	if (catalog.entries.length === 0) {
		lines.push("(none yet)");
	} else {
		for (const e of catalog.entries) {
			const req = e.compatibility ? ` [${e.compatibility}]` : "";
			lines.push(`- ${e.name} — ${e.description}${req} (${e.path})`);
		}
	}
	if (catalog.skipped > 0) {
		lines.push(
			`(${catalog.skipped} ${catalog.skipped === 1 ? "entry" : "entries"} skipped as malformed — see goblin.log)`,
		);
	}
	return lines;
}
