import { relative, sep } from "node:path";
import { z } from "zod";
import { skillNameSchema } from "../skill-provenance.ts";

export interface SkillWatch {
	skillsDir: string;
	proposedDir: string;
	record(conversationId: string, skill: string): void;
}

const writeOutputSchema = z.object({ path: z.string() }).passthrough();

const scriptCallsSchema = z.object({
	calls: z.array(
		z.object({ tool: z.string(), args: z.string(), ok: z.boolean(), result: z.string() }),
	),
});

function skillUnder(watch: SkillWatch, absPath: string): string | null {
	for (const dir of [watch.skillsDir, watch.proposedDir]) {
		const rel = relative(dir, absPath);
		if (rel.startsWith("..") || rel === "") continue;
		const segs = rel.split(sep);
		if (segs.length < 2) continue;
		const name = segs[0]!;
		return skillNameSchema.safeParse(name).success ? name : null;
	}
	return null;
}

function parseSummarized(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

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
			if (!call.ok) continue;
			if (call.tool === "write_file" || call.tool === "edit_file")
				collect(parseSummarized(call.result));
		}
	}
	return [...names];
}
