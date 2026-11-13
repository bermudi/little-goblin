import {
	command,
	errno,
	failure,
	ProbeError,
	result,
	type HealthReport,
	type HealthResult,
	type ProbeContext,
} from "./shared.ts";

// Status has no JSON API. This grammar is pinned to resolve/local.go: only the
// first status line is consumed; failure diagnostics can contain arbitrary data.
function snapshotLine(
	raw: string,
	profile: string,
): { state: string; ageSeconds: number | null; names: Set<string> } {
	const first = raw.split("\n")[0] ?? "";
	const match =
		/^([a-z][a-z0-9_-]{0,63}): (READY|MISSING|LOCKED|BROKEN)  age=([^ ]+)  keys=(\d+)(?:  names=([A-Z0-9_]+(?: [A-Z0-9_]+)*))?$/.exec(
			first,
		);
	if (!match || match[1] !== profile) throw new ProbeError("unverified-status-contract");
	const names = new Set(match[5]?.split(" ") ?? []);
	if (Number(match[4]) !== names.size) throw new ProbeError("invalid-status-key-count");
	let ageSeconds: number | null = null;
	if (match[2] === "READY") {
		const duration = match[3] ?? "";
		if (!/^-?(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?$/.test(duration) || !/\d/.test(duration))
			throw new ProbeError("unverified-status-age");
		ageSeconds = [...duration.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)].reduce(
			(sum, m) => sum + Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1),
			0,
		);
		if (duration.startsWith("-")) ageSeconds = -ageSeconds;
	} else if (match[3] !== "none" || names.size !== 0)
		throw new ProbeError("invalid-unavailable-status");
	return { state: match[2] ?? "BROKEN", ageSeconds, names };
}
export async function snapshots(
	profiles: Map<string, Set<string>>,
	phase: HealthReport["phase"],
	probe: ProbeContext = {},
): Promise<HealthResult[]> {
	if (!profiles.size)
		return [
			result(
				"keys.snapshots",
				"caller-home",
				"skip",
				"No recognized referenced pass-keys profiles; other credential mechanisms unverified",
			),
		];
	const findings = await Promise.all(
		[...profiles]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(async ([profile, needed], index) => {
				const start = performance.now(),
					id = `keys.snapshot.${index + 1}`;
				let scope = "caller-home;operator-wallet";
				try {
					const raw = await command(["pass-keys", "status", profile], 3000, probe, true);
					const status = snapshotLine(raw, profile);
					scope += `;profile:${profile}`;
					const missing = [...needed].filter((name) => !status.names.has(name)).length;
					return result(
						id,
						scope,
						status.state !== "READY" || missing
							? "fail"
							: (status.ageSeconds ?? 0) < 0 || (status.ageSeconds ?? 0) > 86400
								? "warn"
								: "pass",
						`${status.state}; ${needed.size} needed key names checked, ${missing} missing; snapshot age ${status.ageSeconds ?? "unavailable"} seconds${(status.ageSeconds ?? 0) < 0 ? "; clock skew: snapshot timestamp is in the future" : ""}; status metadata only, no credential values in report; status interface pinned from source, wallet implementation not independently verified`,
						start,
					);
				} catch (error) {
					return failure(
						id,
						scope,
						error,
						start,
						"pass-keys status availability (missing/locked/broken cannot be distinguished without valid status metadata)",
					);
				}
			}),
	);
	if (phase === "preflight")
		return [
			...findings,
			result(
				"keys.refresh",
				"caller-home;operator-wallet",
				"skip",
				"Refresh units not required before installation; no warming or unlocking",
			),
		];
	const refresh = await Promise.all(
		["goblin-keys.service", "goblin-keys.timer"].map(async (unit) => {
			const start = performance.now(),
				id = `keys.refresh.${unit.endsWith("timer") ? "timer" : "service"}`,
				scope = "caller-home;operator-wallet";
			try {
				const raw = await command(
					["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState"],
					2000,
					probe,
				);
				const lines = raw.trim().split("\n");
				if (
					lines.length !== 2 ||
					!lines.some((line) => line === "LoadState=loaded") ||
					!lines.some((line) =>
						/^ActiveState=(?:active|inactive|failed|activating|deactivating)$/.test(line),
					)
				)
					throw new ProbeError("refresh-unit-unavailable-or-unverified");
				const healthy = unit.endsWith("timer")
					? lines.includes("ActiveState=active")
					: !lines.includes("ActiveState=failed");
				return result(
					id,
					scope,
					healthy ? "pass" : "warn",
					`${unit}: ${healthy ? "expected current unit state" : "refresh state degraded"}; last sync success, unit configuration and wallet auto-unlock unverified`,
					start,
				);
			} catch (error) {
				return result(
					id,
					scope,
					"warn",
					`Refresh state unverified: ${errno(error)}; no warming or unlocking`,
					start,
				);
			}
		}),
	);
	return [...findings, ...refresh];
}
