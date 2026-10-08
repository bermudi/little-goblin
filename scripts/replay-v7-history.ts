// One-shot migration check (run manually): replays every conversation's
// stored UIMessage history through the v7 SDK read path — history() →
// convertToModelMessages (plus validateUIMessages for the strict pass).
// Works on a COPY of the live DB; never opens the service's own file.

import { convertToModelMessages, safeValidateUIMessages } from "ai";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { openStore } from "../src/conversation.ts";

const live = paths.db();
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
