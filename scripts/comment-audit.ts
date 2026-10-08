// Comment-ratio report (AGENTS.md → Comment policy) — a signal, not a
// gate: exits 0 even when files flag. Comment line = a line matching
// /^\s*(\/\/|\/\*|\*)/; product = src/ + app/src/ minus test files.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FLAG = 0.2;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

function productFiles(dir: string, out: string[]): void {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, ent.name);
		if (ent.isDirectory()) productFiles(path, out);
		else if (/\.(?:ts|tsx|js)$/.test(ent.name) && !/\.test\.[jt]sx?$/.test(ent.name))
			out.push(path);
	}
}

const files: string[] = [];
for (const root of ["src", "app/src"]) productFiles(root, files);

interface Row {
	file: string;
	comments: number;
	total: number;
}

const rows: Row[] = files
	.map((file) => {
		const lines = readFileSync(file, "utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		return {
			file,
			comments: lines.filter((l) => COMMENT.test(l)).length,
			total: lines.length,
		};
	})
	.sort(
		(a, b) =>
			b.comments / (b.total || 1) - a.comments / (a.total || 1) || a.file.localeCompare(b.file),
	);

const wNum = String(Math.max(0, ...rows.map((r) => r.total))).length;
const wFile = Math.max("file".length, ...rows.map((r) => r.file.length));
const ratio = (r: Row): number => (r.total === 0 ? 0 : r.comments / r.total);

const out: string[] = [];
out.push(
	`${"ratio".padStart(6)}  ${"cmts".padStart(wNum)}  ${"total".padStart(wNum)}  ${"file".padEnd(wFile)}`,
);
for (const r of rows) {
	out.push(
		`${(ratio(r) * 100).toFixed(1).padStart(5)}%  ${String(r.comments).padStart(wNum)}  ${String(r.total).padStart(wNum)}  ${r.file.padEnd(wFile)}${ratio(r) > FLAG ? "  <<" : ""}`,
	);
}
const comments = rows.reduce((a, r) => a + r.comments, 0);
const total = rows.reduce((a, r) => a + r.total, 0);
const flagged = rows.filter((r) => ratio(r) > FLAG).length;
out.push("");
out.push(
	`avg ${total === 0 ? 0 : ((comments / total) * 100).toFixed(1)}% over ${comments}/${total} lines · ${flagged}/${rows.length} files over ${FLAG * 100}%`,
);
process.stdout.write(`${out.join("\n")}\n`);
