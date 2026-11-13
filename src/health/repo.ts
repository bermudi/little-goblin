import { existsSync } from "node:fs";
import { join } from "node:path";
import { summarize, tally } from "../test-ratio.ts";
import { command, errno, readBounded, result, type HealthResult, type ProbeContext } from "./shared.ts";

// Repo health, not installation health: informational (warn, never fail). A
// release built by `git archive` has no git metadata, so the ratio is skipped
// there rather than guessed from the filesystem or silently passed. The reads
// go through readBounded like every probe: an over-cap tracked file refuses
// the measurement (a silently truncated read would corrupt the counts) rather
// than shrink it.
export async function testRatio(checkout: string, probe: ProbeContext = {}): Promise<HealthResult> {
	const start = performance.now();
	const scope = `diagnostic-checkout:${checkout}`;
	if (!existsSync(join(checkout, ".git")))
		return result(
			"repo.test-ratio",
			scope,
			"skip",
			"No git metadata in this checkout (release archive); ratio unmeasured",
			start,
		);
	try {
		const paths = (await command(["git", "-C", checkout, "ls-files", "src/"], 5_000, probe))
			.split("\n")
			.filter((p) => /\.tsx?$/.test(p));
		const s = summarize(
			tally(
				paths.map((path) => ({
					path,
					lines: readBounded(join(checkout, path)).text.split("\n").length - 1,
				})),
			),
		);
		const top = s.excess
			.slice(0, 3)
			.map((d) => `${d.dir} +${d.excess}`)
			.join(", ");
		return result(
			"repo.test-ratio",
			scope,
			s.ratio > 1 ? "warn" : "pass",
			`tests ${s.test} / src ${s.prod} lines = ${s.ratio.toFixed(2)}x${s.ratio > 1 ? `; top excess: ${top}` : ""}`,
			start,
		);
	} catch (error) {
		return result("repo.test-ratio", scope, "warn", `Ratio unmeasured: ${errno(error)}`, start);
	}
}
