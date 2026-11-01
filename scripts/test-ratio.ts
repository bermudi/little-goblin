// Test-to-source line ratio — report only, exits 0 at any ratio (a signal, not
// a gate; DESIGN.md → Test posture). Scope: `git ls-files src/`, .ts/.tsx.
// Test side = *.test.ts(x) (live drift checks included) plus test-support
// modules (testkit.ts, testing.ts, *-testing.ts): they exist only for tests.
// Everything else is production.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

export const isTest = (f: string): boolean =>
	/\.test\.tsx?$/.test(f) || /(?:^|\/|-)(?:testkit|testing)\.ts$/.test(f);

export interface Tally {
	prod: number;
	test: number;
}

export function tally(files: { path: string; lines: number }[]): Map<string, Tally> {
	const byDir = new Map<string, Tally>();
	for (const { path, lines } of files) {
		const t = byDir.get(dirname(path)) ?? { prod: 0, test: 0 };
		t[isTest(path) ? "test" : "prod"] += lines;
		byDir.set(dirname(path), t);
	}
	return byDir;
}

if (import.meta.main) {
	const paths = execFileSync("git", ["ls-files", "src/"], { encoding: "utf8" })
		.split("\n")
		.filter((p) => /\.tsx?$/.test(p));
	const byDir = tally(
		paths.map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n").length - 1 })),
	);
	let prod = 0;
	let test = 0;
	for (const t of byDir.values()) {
		prod += t.prod;
		test += t.test;
	}
	const ratio = test / prod;
	console.log(`src/ production ${prod} lines, tests ${test} lines — ratio ${ratio.toFixed(2)}x`);
	if (ratio > 1) console.log("warning: tests exceed source (DESIGN.md: the suite stays smaller than src/)");
	console.log("top directories by excess test lines (test − prod):");
	[...byDir.entries()]
		.map(([dir, t]) => ({ dir, ...t, excess: t.test - t.prod }))
		.filter((d) => d.excess > 0)
		.sort((a, b) => b.excess - a.excess)
		.slice(0, 8)
		.forEach((d) => console.log(`  ${d.dir}: +${d.excess} (prod ${d.prod}, tests ${d.test})`));
}
