import { command, ProbeError, type ProbeContext } from "./shared.ts";

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
