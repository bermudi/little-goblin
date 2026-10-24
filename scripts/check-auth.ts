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
//
// Runs BEFORE `bun install` on a fresh checkout — ./src/auth-parse.ts
// is a dependency-free leaf precisely so this gate needs no
// node_modules. Do not import config.ts or anything heavier here.
import { readFileSync } from "node:fs";
import { authFile, invokesPassCliDirectly, parseAuthRecords } from "../src/auth-parse.ts";

const file = authFile();
let raw: string;
try {
	raw = readFileSync(file, "utf8");
} catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	process.stderr.write(
		`${JSON.stringify({ level: "warn", msg: "no auth.jsonl — no records to scan", path: file })}\n`,
	);
	process.exit(0);
}

const offenders = new Set<string>();
for (const rec of parseAuthRecords(raw, file)) {
	if (rec.value.startsWith("!") && invokesPassCliDirectly(rec.value.slice(1))) {
		offenders.add(rec.name);
	}
}
for (const name of offenders) {
	process.stdout.write(name + "\n");
}
process.exit(offenders.size > 0 ? 2 : 0);
