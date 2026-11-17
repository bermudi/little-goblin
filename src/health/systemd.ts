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


