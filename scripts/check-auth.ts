// Install-time gate: a `!` record whose command invokes pass-cli
// directly would resolve as the owner session — full account, no audit
// trail. loadAuth only poisons it (the unit must never crash-loop), so
// the installer refuses it here instead.
//
// Prints ONLY the offending records' names, one per line, and exits 2
// when any exist — a dedicated code so the caller can tell "offenders
// found" apart from the check itself failing (any other nonzero).
// Values are secret material and never print — process.stdout.write,
// not `log`, keeps the output bare names. A missing auth.jsonl (the
// fresh-install norm) is an empty store: exit 0 with one structured
// stderr note, stdout staying bare names only.
import { readFileSync } from "node:fs";
import { invokesPassCliDirectly, parseAuthFile } from "../src/auth.ts";
import { paths } from "../src/config.ts";

let raw: string;
try {
	raw = readFileSync(paths.auth(), "utf8");
} catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	process.stderr.write(
		`${JSON.stringify({ level: "warn", msg: "no auth.jsonl — no records to scan", path: paths.auth() })}\n`,
	);
	process.exit(0);
}

const offenders = new Set<string>();
for (const rec of parseAuthFile(raw)) {
	if (rec.value.startsWith("!") && invokesPassCliDirectly(rec.value.slice(1))) {
		offenders.add(rec.name);
	}
}
for (const name of offenders) {
	process.stdout.write(name + "\n");
}
process.exit(offenders.size > 0 ? 2 : 0);
