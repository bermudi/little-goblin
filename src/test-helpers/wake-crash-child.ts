// Child process for the wake-store crash test: a real goblin.sqlite
// whose wake store commits a MODE-selected point, then stalls for the
// parent's SIGKILL. Env (no secrets): DB_PATH, MARKER_PATH, MODE —
//   recorded:  the development is recorded (event + pending wake
//              committed); the trigger append never starts — the kill
//              lands on the record/append boundary.
//   committed: the trigger append and its history stamp commit as one
//              transaction, before any submit — the kill lands on the
//              append/submit boundary.
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UIMessage } from "ai";
import { openStore } from "../conversation.ts";
import { setLogFile } from "../log.ts";
import { openWakeStore } from "../wake-store.ts";

const DB_PATH = process.env.DB_PATH ?? "";
const MARKER_PATH = process.env.MARKER_PATH ?? "";
const MODE = process.env.MODE ?? "";
if (DB_PATH === "" || MARKER_PATH === "" || MODE === "") {
	throw new Error("DB_PATH/MARKER_PATH/MODE are required");
}
setLogFile(null);

const idle = () => new Promise<never>(() => {});

const store = openStore(DB_PATH);
const conv = store.resolve({ kind: "dm", chatId: 7 }, dirname(DB_PATH));
const wakes = openWakeStore(store.db);
const rec = wakes.record({
	sourceKey: "poll:1",
	conversationId: conv.id,
	kind: "done-candidate",
	text: "the development",
	facts: { seq: 7 },
	origin: "observer",
});
if (MODE === "committed") {
	wakes.commit(rec.wakeId, (t) => {
		const message: UIMessage = {
			id: t.id,
			role: "user",
			parts: [{ type: "text", text: t.text }],
		};
		store.append(conv.id, [message]);
	});
}
writeFileSync(MARKER_PATH, "ready");
await idle();
