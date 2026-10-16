// Turn-side skill attribution (design/skills.md → Skill provenance):
// exact-path detection of write_file/edit_file calls (a script's nested
// calls included) that author a skill during a conversation's turn.
// Detection rides the tool's resolved output path — where the bytes
// actually landed — so a project conversation writing `skills/…` inside
// its own workdir is correctly not attributed, and a symlinked skill
// dir that writes through to its outside target is a documented miss
// (the state viewer's symlink ruling precedent: symlinks are
// second-class). Bash is deliberately not scanned — arbitrary shell is
// not parseable, and approval dir-moves ride bash; a string match
// would record them as generation.
import { relative, sep } from "node:path";
import { z } from "zod";
import { skillNameSchema } from "../skill-provenance.ts";

export interface SkillWatch {
	skillsDir: string;
	proposedDir: string;
	record(conversationId: string, skill: string): void;
}

// Both file tools return the resolved absolute path on success; soft
// failures return {error} with no path and attribute nothing.
const writeOutputSchema = z.object({ path: z.string() }).passthrough();

// The script tool's stored-output shape (stream.ts keeps the twin it
// expands into the digest): nested calls with summarized JSON strings.
const scriptCallsSchema = z.object({
	calls: z.array(
		z.object({ tool: z.string(), args: z.string(), ok: z.boolean(), result: z.string() }),
	),
});

/** The skill directory a resolved write path lands in, or null. */
function skillUnder(watch: SkillWatch, absPath: string): string | null {
	for (const dir of [watch.skillsDir, watch.proposedDir]) {
		const rel = relative(dir, absPath);
		if (rel.startsWith("..") || rel === "") continue;
		// Catalog entries are directories: the write must land at least
		// one level inside (`<name>/SKILL.md`), never be a bare file
		// directly under the root.
		const segs = rel.split(sep);
		if (segs.length < 2) continue;
		const name = segs[0]!;
		return skillNameSchema.safeParse(name).success ? name : null;
	}
	return null;
}

// A summarized string field: the JSON it carries, parsed best-effort —
// truncation may have cut it, and a cut record attributes nothing.
function parseSummarized(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

/** Skill names authored by this completed call — empty when none. */
export function attributedSkills(watch: SkillWatch, tool: string, output: unknown): string[] {
	const names = new Set<string>();
	const collect = (callOutput: unknown): void => {
		const out = writeOutputSchema.safeParse(callOutput);
		if (!out.success) return;
		const name = skillUnder(watch, out.data.path);
		if (name !== null) names.add(name);
	};
	if (tool === "write_file" || tool === "edit_file") {
		collect(output);
		return [...names];
	}
	if (tool === "script") {
		const parsed = scriptCallsSchema.safeParse(output);
		if (!parsed.success) return [];
		for (const call of parsed.data.calls) {
			// A nested call that failed wrote nothing.
			if (!call.ok) continue;
			if (call.tool === "write_file" || call.tool === "edit_file") collect(call.result);
		}
	}
	return [...names];
}
