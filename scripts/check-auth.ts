// Install-time gate (DESIGN.md: Auth → "Proton Pass"): a `!` record
// whose command invokes pass-cli directly would resolve as the owner
// session — full account, no audit trail. loadAuth only poisons it (the
// unit must never crash-loop), so install.sh refuses it here instead.
//
// Prints ONLY the offending records' names, one per line, and exits 1
// when any exist. Values are secret material and never print — stdout
// is written through process.stdout.write, not `log`, precisely so the
// output stays bare names.
import { readFileSync } from "node:fs";
import { invokesPassCliDirectly, parseAuthFile } from "../src/auth.ts";
import { paths } from "../src/config.ts";

const offenders = new Set<string>();
for (const rec of parseAuthFile(readFileSync(paths.auth(), "utf8"))) {
	if (rec.value.startsWith("!") && invokesPassCliDirectly(rec.value.slice(1))) {
		offenders.add(rec.name);
	}
}
for (const name of offenders) {
	process.stdout.write(name + "\n");
}
process.exit(offenders.size > 0 ? 1 : 0);
