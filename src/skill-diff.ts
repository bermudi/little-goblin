// What a proposed skill changes against the installed copy of the same
// name (issue #162: an update can't be judged in a vacuum). Pure over
// file contents — the directory reads and their containment wall live in
// stateview.ts.

import { type DiffLine, diffLines } from "./line-diff.ts";

export interface SkillFileDiff {
	path: string;
	status: "added" | "removed" | "changed";
	/** A NUL byte: no line diff exists, only the status. */
	binary: boolean;
	/** Lines added / removed; 0 for binary files. */
	added: number;
	removed: number;
	lines: DiffLine[];
}

export interface SkillDiff {
	/** "update": an installed skill of this name exists. "new": none does. */
	kind: "new" | "update";
	/** Changed files only, SKILL.md first. */
	files: SkillFileDiff[];
	/** Paths present and identical in both copies. */
	unchanged: string[];
}

function isBinary(bytes: Buffer): boolean {
	return bytes.includes(0);
}

function fileDiff(path: string, before: Buffer | null, after: Buffer | null): SkillFileDiff {
	const status = before === null ? "added" : after === null ? "removed" : "changed";
	if ((before !== null && isBinary(before)) || (after !== null && isBinary(after))) {
		return { path, status, binary: true, added: 0, removed: 0, lines: [] };
	}
	const lines = diffLines(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "");
	return {
		path,
		status,
		binary: false,
		added: lines.filter((l) => l.op === "add").length,
		removed: lines.filter((l) => l.op === "del").length,
		lines,
	};
}

function skillFirst(a: string, b: string): number {
	if (a === "SKILL.md") return -1;
	if (b === "SKILL.md") return 1;
	return a.localeCompare(b);
}

/** `installed` is null when no skill of this name is installed. */
export function diffSkill(
	installed: ReadonlyMap<string, Buffer> | null,
	proposed: ReadonlyMap<string, Buffer>,
): SkillDiff {
	const old = installed ?? new Map<string, Buffer>();
	const files: SkillFileDiff[] = [];
	const unchanged: string[] = [];
	for (const path of new Set([...old.keys(), ...proposed.keys()])) {
		const before = old.get(path) ?? null;
		const after = proposed.get(path) ?? null;
		if (before !== null && after !== null && before.equals(after)) unchanged.push(path);
		else files.push(fileDiff(path, before, after));
	}
	files.sort((a, b) => skillFirst(a.path, b.path));
	unchanged.sort(skillFirst);
	return { kind: installed === null ? "new" : "update", files, unchanged };
}
