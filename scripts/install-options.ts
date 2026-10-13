import { readFileSync } from "node:fs";
import { parseAuthFile, parsePassKeysGet, passKeysCommandExecutable } from "../src/auth.ts";
import { authReferences, parseConfig, paths } from "../src/config.ts";
import JSON5 from "json5";

try {
	const config = parseConfig(JSON5.parse(readFileSync(paths.config(), "utf8")) as unknown);
	const records = parseAuthFile(readFileSync(paths.auth(), "utf8"));
	// Profile names are data, not installer constants: the warmer is
	// rendered from these, so only the record shape is enforced here.
	// The profile class mirrors the doctor's auth probe (src/health.ts).
	// Only config-referenced records render warm lines — the same set
	// preflight gates. A stale unreferenced record must not ship a warm
	// line for an unprovisioned profile: a oneshot unit stops at the
	// first failing ExecStart and Restart loops it forever.
	const refs = authReferences(config);
	// Same-name records overwrite — the last line is the live one, same
	// as the runtime's own auth map. Without the fold a retired pass
	// record still marks keys and warms a profile the current record
	// no longer names.
	const effective = new Map<string, (typeof records)[number]>();
	for (const record of records) effective.set(record.name, record);
	const profiles = new Set<string>();
	let keys = false;
	for (const record of effective.values()) {
		if (passKeysCommandExecutable(record.value) === undefined) continue;
		keys = true;
		if (!refs.has(record.name)) continue;
		const parsed = parsePassKeysGet(record.value);
		if (parsed === null) throw new Error("unsupported-pass-record");
		profiles.add(parsed.profile);
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
