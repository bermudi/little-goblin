// The ping map's lifecycle: rows are written per delivered ping, and
// the sweep is what keeps the table from growing without bound — a row
// whose app conversation is gone is unroutable garbage (intake guards
// store.get(hit) !== null and falls through to ordinary DM routing),
// so it is deleted opportunistically on the next record (#110).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { openPings } from "./pings.ts";

describe("ping map", () => {
	test("recording a ping sweeps rows whose conversation no longer exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-pings-"));
		try {
			const store = openStore(join(dir, "goblin.sqlite"));
			const pings = openPings(store.db);
			const live = store.resolve({ kind: "dm", chatId: 1 }, "/w");
			const dead = store.resolve({ kind: "dm", chatId: 2 }, "/w");
			pings.record(1, 10, live.id);
			pings.record(1, 11, dead.id);
			expect(pings.lookup(1, 10)).toBe(live.id);
			expect(pings.lookup(1, 11)).toBe(dead.id);
			store.deleteConversation(dead.id);
			// Still there until the next record — the sweep rides the rare
			// write path, never intake's hot lookup.
			expect(pings.lookup(1, 11)).toBe(dead.id);
			pings.record(1, 12, live.id);
			expect(pings.lookup(1, 11)).toBeNull();
			expect(pings.lookup(1, 10)).toBe(live.id);
			expect(pings.lookup(1, 12)).toBe(live.id);
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
