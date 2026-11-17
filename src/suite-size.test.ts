import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;
// AGENTS.md → Tests. Lower it when the ratio drops; never raise it without the operator's OK.
const RATIO_CEILING = 1.30;

function countLines(path: string): number {
	return (readFileSync(path, "utf8").match(/\n/g) ?? []).length;
}

function countSuiteLines(): { testLines: number; sourceLines: number } {
	let testLines = 0;
	let sourceLines = 0;
	const pending = [SRC];

	while (pending.length > 0) {
		const directory = pending.pop();
		if (directory === undefined) throw new Error("pending directory disappeared");

		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				if (entry.name.endsWith(".test.ts")) testLines += countLines(path);
				else sourceLines += countLines(path);
			}
		}
	}

	return { testLines, sourceLines };
}

const { testLines, sourceLines } = countSuiteLines();
const ratio = testLines / sourceLines;

test("test/src line ratio stays under its ceiling", () => {
	expect(
		ratio,
		`test/src line ratio ${ratio.toFixed(3)} exceeds ceiling ${RATIO_CEILING} — cut or merge tests, don't raise the ceiling; test lines: ${testLines}, source lines: ${sourceLines}`,
	).toBeLessThanOrEqual(RATIO_CEILING);
});

test("test/src line ratio ceiling ratchets down", () => {
	expect(
		ratio,
		`ratio fell to ${ratio.toFixed(3)} — lower RATIO_CEILING to ${(Math.ceil(ratio * 100) / 100).toFixed(2)}`,
	).toBeGreaterThanOrEqual(RATIO_CEILING - 0.02);
});
