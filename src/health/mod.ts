import { resolve } from "node:path";
import { authCheck, cacheContracts, configCheck, operatorIds } from "./config-auth.ts";
import { providerReadiness } from "./providers.ts";
import { installation } from "./installation.ts";
import { snapshots } from "./keys.ts";
import { memory } from "./memory.ts";
import { observer } from "./observer.ts";
import { testRatio } from "./repo.ts";
import { sandbox } from "./sandbox.ts";
import {
	capacity,
	healthReportSchema,
	type HealthReport,
	type ProbeContext,
} from "./shared.ts";
import { sqlite } from "./sqlite.ts";
import { workspace } from "./workspace.ts";

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
		operatorIds(config.config, home),
		cacheContracts(config.config, home),
		...auth.findings,
		...providerReadiness(config.config, auth.names),
		...workspace(home, options.phase),
		...observer(home, options.phase),
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
