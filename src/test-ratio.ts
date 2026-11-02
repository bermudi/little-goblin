// Test-to-source line ratio — pure measurement shared by `scripts/test-ratio.ts`
// (report) and doctor's repo-health check. A signal, not a gate (DESIGN.md →
// Test posture). Scope: `git ls-files src/`, .ts/.tsx. Test side = *.test.ts(x)
// (live drift checks included) plus test-support modules (testkit.ts,
// testing.ts, *-testing.ts, src/test-helpers/**): they exist only for tests.
// Everything else is production.

import { dirname } from "node:path";

export const isTest = (f: string): boolean =>
	/\.test\.tsx?$/.test(f) || f.startsWith("src/test-helpers/") || /(?:^|\/|-)(?:testkit|testing)\.ts$/.test(f);

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

export interface RatioSummary {
	prod: number;
	test: number;
	ratio: number;
	excess: { dir: string; prod: number; test: number; excess: number }[];
}

export function summarize(byDir: Map<string, Tally>, top = 8): RatioSummary {
	let prod = 0;
	let test = 0;
	for (const t of byDir.values()) {
		prod += t.prod;
		test += t.test;
	}
	const excess = [...byDir.entries()]
		.map(([dir, t]) => ({ dir, ...t, excess: t.test - t.prod }))
		.filter((d) => d.excess > 0)
		.sort((a, b) => b.excess - a.excess)
		.slice(0, top);
	return { prod, test, ratio: prod === 0 ? 0 : test / prod, excess };
}
