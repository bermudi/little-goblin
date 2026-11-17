import { describe, expect, test } from "bun:test";
import { openStore } from "./conversation.ts";
import type { Runtime } from "./runtime.ts";
import { tmpDb } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";
import { makeWakeDispatcher } from "./wake-dispatcher.ts";
import { openWakeStore } from "./wake-store.ts";

const dispatcher = (
	store: ReturnType<typeof openStore>,
	wakes: ReturnType<typeof openWakeStore>,
	submitPersisted: () => boolean,
	now: number,
	journal = openTurnJournal(store.db),
) => makeWakeDispatcher({
	store, wakes, journal,
	runtime: { accepting: () => true, isAdmitted: () => false, submitPersisted } as unknown as Runtime,
	sinkFor: () => ({} as never), backoff: { baseMs: 1, capMs: 1 }, now: () => now,
});

describe("wake dispatcher crash recovery", () => {
	test("a claimed wake retries submit after boot without appending its trigger twice", () => {
		const path = tmpDb("goblin-wake-dispatch-crash-");
		const first = openStore(path);
		const conv = first.resolve({ kind: "dm", chatId: 7 }, "/w");
		const wakes = openWakeStore(first.db);
		let submits = 0;
		const dispatch = dispatcher(first, wakes, () => {
			submits++;
			return true;
		}, 1_000);
		const recorded = dispatch.record({
			sourceKey: "crash-gap",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "the trigger",
			facts: {},
			origin: "observer",
		});
		expect(submits).toBe(1);
		first.close();

		const boot = openStore(path);
		const bootJournal = openTurnJournal(boot.db);
		const bootWakes = openWakeStore(boot.db);
		expect(bootJournal.pendingBootNotices().stranded).toEqual([
			{ id: expect.any(Number), conversationId: conv.id, count: 1 },
		]);
		const bootDispatcher = dispatcher(boot, bootWakes, () => {
			submits++;
			return true;
		}, 2_000, bootJournal);
		bootDispatcher.pump();
		expect(submits).toBe(2);
		expect(bootWakes.get(recorded.wakeId)?.state).toBe("claimed");
		expect(boot.historyEntries(conv.id)).toHaveLength(1);
		boot.close();
	});
});
