// Test-to-source line ratio report — exits 0 at any ratio (a signal, not a
// gate; DESIGN.md → Test posture). The measurement lives in src/test-ratio.ts
// so doctor shares it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { summarize, tally } from "../src/test-ratio.ts";

export { isTest, tally } from "../src/test-ratio.ts";

if (import.meta.main) {
	const paths = execFileSync("git", ["ls-files", "src/"], { encoding: "utf8" })
		.split("\n")
		.filter((p) => /\.tsx?$/.test(p));
	const s = summarize(
		tally(paths.map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n").length - 1 }))),
	);
	console.log(`src/ production ${s.prod} lines, tests ${s.test} lines — ratio ${s.ratio.toFixed(2)}x`);
	if (s.ratio > 1) console.log("warning: tests exceed source (DESIGN.md: the suite stays smaller than src/)");
	console.log("top directories by excess test lines (test − prod):");
	for (const d of s.excess) console.log(`  ${d.dir}: +${d.excess} (prod ${d.prod}, tests ${d.test})`);
}
