import { closeSync, constants, existsSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { sqliteProbeSchema } from "./health-sqlite.ts";
import { summarize, tally } from "./test-ratio.ts";
import { checkAppAssets } from "./health/app-assets.ts";
import { authCheck, cacheContracts, configCheck } from "./health/config-auth.ts";
import { http } from "./health/http.ts";
import { sqlite } from "./health/sqlite.ts";
import { installation } from "./health/installation.ts";
import { snapshots } from "./health/keys.ts";
import { memory } from "./health/memory.ts";
import { sandbox } from "./health/sandbox.ts";
import { herdrUnit, systemdShow } from "./health/systemd.ts";
import { workspace } from "./health/workspace.ts";
import {
	capacity,
	command,
	errno,
	failure,
	healthReportSchema,
	ProbeError,
	readBounded,
	result,
	type HealthReport,
	type HealthResult,
	type ProbeContext,
} from "./health/shared.ts";

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

export async function runHealth(options: {
	home: string;
	checkout: string;
	phase: "preflight" | "installed";
	signal?: AbortSignal;
	probe?: Pick<ProbeContext, "processGroup">;
}): Promise<HealthReport> {
	const home = resolve(options.home),
		checkout = resolve(options.checkout);
	const checkedAt = new Date().toISOString();
	const config = configCheck(home);
	const auth = authCheck(home, config.config);
	const local = [
		config.finding,
		cacheContracts(config.config, home),
		...auth.findings,
		...workspace(home, options.phase),
		capacity(home, "storage.home", `caller-home:${home}`),
	];
	const probe: ProbeContext = {
		...options.probe,
		...(options.signal ? { signal: options.signal } : {}),
	};
	const [db, install, keys, mem, sbx, ratio] = await Promise.all([
		sqlite(home, options.phase, probe, config.config),
		installation(checkout, options.phase, probe, config.config?.delegation !== undefined),
		snapshots(auth.profiles, options.phase, probe),
		memory(config.config, checkout, options.phase, probe),
		sandbox(config.config, probe),
		testRatio(checkout, probe),
	]);
	return healthReportSchema.parse({
		version: 1,
		checkedAt,
		phase: options.phase,
		target: { home, checkout },
		results: [...local, ...db, ...install, ...keys, ...mem, ...sbx, ratio],
	});
}
