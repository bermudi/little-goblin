import { z } from "zod";
import { command, errno, ProbeError, result, type HealthResult, type ProbeContext } from "./shared.ts";

const unitStateSchema = z.object({
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
});

export async function systemdShow(
	unit: string,
	properties: readonly string[],
	probe: ProbeContext,
): Promise<Record<string, string>> {
	const raw = await command(
		["systemctl", "--user", "show", unit, `--property=${properties.join(",")}`],
		2000,
		probe,
	);
	const out: Record<string, string> = {};
	for (const line of raw.trim().split("\n")) {
		const match = /^([A-Za-z]+)=(.*)$/.exec(line);
		if (!match?.[1] || match[2] === undefined || Object.hasOwn(out, match[1]))
			throw new ProbeError("invalid-systemd-properties");
		out[match[1]] = match[2];
	}
	return out;
}

// goblin-herdr.service hosts the operator's herdr session (interactive
// panes). Delegation stopped riding it with the T3 Code transport
// (#607) and the unit retires in #608 — a dead unit degrades the panes
// only, so it warns and never fails.
export async function herdrUnit(scope: string, probe: ProbeContext): Promise<HealthResult> {
	const start = performance.now(),
		id = "service.goblin-herdr";
	try {
		const props = await systemdShow(
			"goblin-herdr.service",
			["LoadState", "ActiveState", "SubState"],
			probe,
		);
		const parsed = unitStateSchema.safeParse(props);
		if (!parsed.success) throw new ProbeError("invalid-systemd-properties");
		const p = parsed.data;
		const healthy =
			p.LoadState === "loaded" && p.ActiveState === "active" && p.SubState === "running";
		return result(
			id,
			scope,
			healthy ? "pass" : "warn",
			`${p.LoadState}/${p.ActiveState}/${p.SubState}; ${
				healthy
					? "herdr session up (delegation no longer rides it)"
					: "herdr session down — panes riding it are unreachable; delegation is unaffected"
			}; pane contents and herdr wire unverified`,
			start,
		);
	} catch (error) {
		return result(
			id,
			scope,
			"warn",
			`Herdr unit unverified: ${errno(error)}`,
			start,
		);
	}
}
