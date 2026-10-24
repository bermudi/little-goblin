// One-shot migration check (run manually): replays every conversation's
// stored UIMessage history through the v7 SDK read path — history() →
// convertToModelMessages (plus validateUIMessages for the strict pass).
// Refuses to run while goblin.service is active: the copy below is a
// raw cpSync, and a raw copy taken across a WAL checkpoint can tear the
// database (docs/operations.md → Backups). Stop the unit first — on a
// stopped unit the copy reads the service's own files without opening
// them, and the copy is what gets opened.

import { convertToModelMessages, safeValidateUIMessages } from "ai";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "../src/config.ts";
import { openStore } from "../src/conversation.ts";
import { boundedRun, spawnProc } from "../src/proc.ts";

const live = paths.db();
// Anything but a clean stop refuses: `failed` and `activating` units
// come back (Restart=on-failure), and an unreportable state proves
// nothing. Only `inactive` is a stopped service.
let state: string;
try {
	const proc = spawnProc(
		["systemctl", "--user", "is-active", "goblin.service"],
		resolve(import.meta.dir, ".."),
	);
	const result = await boundedRun(proc, { timeoutMs: 5000, maxOutput: 64 * 1024 });
	state = result.stdout.trim();
} catch (error) {
	console.error(`replay-v7-history: cannot verify goblin.service is stopped: ${String(error)}`);
	process.exit(2);
}
if (state !== "inactive") {
	console.error(
		`replay-v7-history: goblin.service is ${state === "" ? "unreportable" : state} — stop it first; a raw copy taken while it runs can tear the database (docs/operations.md → Backups)`,
	);
	process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "goblin-replay-"));
for (const suffix of ["", "-wal", "-shm"]) {
	try {
		cpSync(live + suffix, join(dir, "db.sqlite" + suffix));
	} catch (err) {
		if (suffix !== "" && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
		throw new Error(`cannot copy ${live + suffix} for history replay: ${String(err)}`, {
			cause: err,
		});
	}
}
const store = openStore(join(dir, "db.sqlite"));
const ids = store.db
	.query<{ id: string }, []>("SELECT id FROM conversations")
	.all()
	.map((r) => r.id);

let messages = 0;
let failures = 0;
for (const id of ids) {
	const history = store.history(id);
	messages += history.length;
	// The strict pass goblin never called on v5 — cheap to prove now.
	const validated = await safeValidateUIMessages({ messages: history });
	if (!validated.success) {
		failures++;
		console.error(`[strict] ${id}: ${validated.error.message.slice(0, 200)}`);
		continue;
	}
	try {
		// The exact shape the turn loop sends (runtime.ts): tools omitted
		// here differ only by tool-part validation, covered by the suite.
		const model = await convertToModelMessages(validated.data, {
			ignoreIncompleteToolCalls: true,
		});
		console.log(`ok ${id}: ${history.length} ui → ${model.length} model messages`);
	} catch (err) {
		failures++;
		console.error(`[convert] ${id}: ${String(err).slice(0, 300)}`);
	}
}
store.close();
console.log(`\n${ids.length} conversations, ${messages} messages, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
