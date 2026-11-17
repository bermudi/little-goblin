// Test-to-source line ratio report — exits 0 at any ratio. The gate is
// `src/suite-size.test.ts`; DESIGN.md → Test posture. Measurement is shared
// with doctor in src/test-ratio.ts.

import { RATIO_CEILING, measureRatio } from "../src/test-ratio.ts";

export { isTest, tally } from "../src/test-ratio.ts";

if (import.meta.main) {
	const s = measureRatio(process.cwd());
	console.log(`src/ production ${s.prod} lines, tests ${s.test} lines — ratio ${s.ratio.toFixed(2)}x`);
	if (s.ratio > RATIO_CEILING)
		console.log(`warning: ratio above the ratchet ceiling ${RATIO_CEILING} (AGENTS.md → Tests)`);
	console.log("top directories by excess test lines (test − prod):");
	for (const d of s.excess) console.log(`  ${d.dir}: +${d.excess} (prod ${d.prod}, tests ${d.test})`);
}
