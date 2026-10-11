import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseAuthFile } from "../src/auth.ts";
import { authReferences, parseConfig, paths } from "../src/config.ts";
import JSON5 from "json5";

try {
	const config = parseConfig(JSON5.parse(readFileSync(paths.config(), "utf8")) as unknown);
	const records = parseAuthFile(readFileSync(paths.auth(), "utf8"));
	const passCommand = (value: string): string | undefined => {
		if (!value.startsWith("!")) return undefined;
		const executable = value.slice(1).match(/^[^\s;&|()"'`]+/)?.[0];
		return executable && basename(executable) === "pass-keys" ? executable : undefined;
	};
	// Profile names are data, not installer constants: the warmer is
	// rendered from these, so only the record shape is enforced here.
	// The profile class mirrors the doctor's auth probe (src/health.ts).
	// Only config-referenced records render warm lines — the same set
	// preflight gates. A stale unreferenced record must not ship a warm
	// line for an unprovisioned profile: a oneshot unit stops at the
	// first failing ExecStart and Restart loops it forever.
	const refs = authReferences(config);
	const profiles = new Set<string>();
	let keys = false;
	for (const record of records) {
		const executable = passCommand(record.value);
		if (executable === undefined) continue;
		keys = true;
		if (!refs.has(record.name)) continue;
		const match = /^ get ([a-z][a-z0-9_-]{0,63}) [A-Za-z0-9_-]+$/.exec(
			record.value.slice(1 + executable.length),
		);
		if (!match?.[1]) throw new Error("unsupported-pass-record");
		profiles.add(match[1]);
	}
	process.stdout.write(
		JSON.stringify({
			delegation: config.delegation !== undefined,
			keys,
			port: config.http.port,
			profiles: [...profiles].sort(),
		}),
	);
} catch {
	process.stderr.write(
		"install: unable to inspect setup options — validate config/auth and use pass-keys get <profile> NAME records with provisioned profiles\n",
	);
	process.exitCode = 1;
}
