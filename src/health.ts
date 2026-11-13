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
import { testRatio } from "./health/repo.ts";
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
