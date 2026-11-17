import { expect, test } from "bun:test";
import { join } from "node:path";
import { measureRatio, RATIO_CEILING } from "./test-ratio.ts";

const summary = measureRatio(join(import.meta.dir, ".."));
const { test: testLines, prod: sourceLines, ratio } = summary;
const topExcess = summary.excess.map(({ dir, excess }) => `${dir} +${excess}`).join(", ") || "none";

test("test/src line ratio stays under its ceiling", () => {
	expect(
		ratio,
		`test/src line ratio ${ratio.toFixed(3)} exceeds ceiling ${RATIO_CEILING} — cut or merge tests, don't raise the ceiling; test lines: ${testLines}, source lines: ${sourceLines}; top excess dirs: ${topExcess}`,
	).toBeLessThanOrEqual(RATIO_CEILING);
});

test("test/src line ratio ceiling ratchets down", () => {
	expect(
		ratio,
		`ratio fell to ${ratio.toFixed(3)} — lower RATIO_CEILING to ${(Math.ceil(ratio * 100) / 100).toFixed(2)}`,
	).toBeGreaterThanOrEqual(RATIO_CEILING - 0.02);
});
