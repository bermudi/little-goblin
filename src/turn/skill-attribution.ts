import { relative, sep } from "node:path";
import { skillNameSchema } from "../skill-provenance.ts";

export function skillUnderPath(dirs: string[], absPath: string): string | null {
	for (const dir of dirs) {
		const rel = relative(dir, absPath);
		if (rel.startsWith("..") || rel === "") continue;
		const segs = rel.split(sep);
		if (segs.length < 2) continue;
		const name = segs[0]!;
		return skillNameSchema.safeParse(name).success ? name : null;
	}
	return null;
}
