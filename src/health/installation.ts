import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { checkAppAssets } from "./app-assets.ts";
import { herdrUnit, systemdShow } from "./systemd.ts";
import {
	failure,
	ProbeError,
	result,
	type HealthReport,
	type HealthResult,
	type ProbeContext,
} from "./shared.ts";

export async function installation(
	checkout: string,
	phase: HealthReport["phase"],
	probe: ProbeContext = {},
	delegationConfigured = false,
): Promise<HealthResult[]> {
	const start = performance.now(),
		scope = `diagnostic-revision:${checkout}`;
	if (phase === "preflight")
		return [
			result("service.goblin", scope, "skip", "Unit not required before installation", start),
			result("service.goblin-herdr", scope, "skip", "Unit not required before installation", start),
			result(
				"app.assets",
				`installed-checkout:${checkout}`,
				"skip",
				"Assets not required before build; caller must checkAppAssets after build",
				start,
			),
		];
	let installed: string | undefined;
	let finding: HealthResult;
	// The herdr probe shares the systemctl boundary and the same deadline
	// budget — run it beside the service probe, not after it.
	const herdr = herdrUnit(scope, delegationConfigured, probe);
	try {
		const properties = await systemdShow(
			"goblin.service",
			["LoadState", "ActiveState", "SubState", "WorkingDirectory"],
			probe,
		);
		const parsed = z
			.object({
				LoadState: z.enum(["loaded", "not-found", "error", "masked", "bad-setting"]),
				ActiveState: z.enum([
					"active",
					"inactive",
					"failed",
					"activating",
					"deactivating",
					"reloading",
					"refreshing",
					"maintenance",
				]),
				SubState: z.string().max(64),
				WorkingDirectory: z.string().max(4096),
			})
			.safeParse(properties);
		if (!parsed.success) throw new ProbeError("invalid-systemd-properties");
		const p = parsed.data;
		if (isAbsolute(p.WorkingDirectory)) installed = resolve(p.WorkingDirectory);
		const failed =
			p.LoadState !== "loaded" || p.ActiveState !== "active" || p.SubState !== "running";
		finding = result(
			"service.goblin",
			scope,
			failed ? "fail" : installed !== checkout ? "warn" : "pass",
			`${p.LoadState}/${p.ActiveState}; ${p.SubState === "running" ? "running substate" : "not in running substate"}; ${installed === checkout ? "WorkingDirectory matches diagnostic checkout" : "WorkingDirectory missing or differs; installed compatibility unverified"}; process-loaded config, readiness and revision identity unverified`,
			start,
		);
	} catch (error) {
		finding = failure("service.goblin", scope, error, start, "Inspect safe systemd properties");
	}
	const assets = checkAppAssets(installed ?? checkout);
	if (!installed) assets.detail += "; installed target unknown, diagnostic checkout inspected only";
	return [
		finding,
		await herdr,
		result(
			"installation.coverage",
			scope,
			"warn",
			"Git revision identity, launcher targets and running-process readiness unverified; no Environment or journal inspected",
		),
		assets,
	];
}
