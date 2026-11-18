import { describe, expect, test } from "bun:test";
import { openWireStep } from "./delivery.ts";
import { openStore } from "../conversation.ts";
import { openResponsibilities } from "../responsibilities.ts";
import { openTurnJournal } from "../turn-journal.ts";
import { openWakeStore } from "../wake-store.ts";
import type { Runtime } from "../runtime.ts";

describe("boot delivery", () => {
	test("holds persisted wakes until completeBoot binds the late owners", () => {
		const store = openStore(":memory:");
		const conv = store.resolve(
			{ kind: "app", appId: "boot-ready", chatId: 0, threadId: 0 },
			"/workspace",
		);
		const wakes = openWakeStore(store.db);
		wakes.record({
			sourceKey: "persisted-before-boot",
			conversationId: conv.id,
			kind: "boot-test",
			text: "run after owners bind",
			facts: {},
			origin: "test",
		});
		const responsibilities = openResponsibilities(store.db);
		const journal = openTurnJournal(store.db);
		let ownersBound = false;
		const submitted: string[] = [];
		const runtime = {
			accepting: () => true,
			isAdmitted: () => false,
			submitPersisted: (conversation: { id: string }) => {
				expect(ownersBound).toBe(true);
				submitted.push(conversation.id);
				return true;
			},
		} as unknown as Runtime;
		const wire = openWireStep();
		const delivery = wire.wire({
			store,
			runtime,
			journal,
			wakes,
			configRef: { current: { operators: [], telegram: {} } } as never,
			auth: {} as never,
			push: { notifyDone: async () => false } as never,
			gate: null,
			programs: {} as never,
			responsibilities,
			telegramApi: () => null,
		});

		try {
			expect(submitted).toEqual([]);
			ownersBound = true;
			wire.completeBoot(null, null);
			expect(submitted).toEqual([conv.id]);
			expect(wakes.pending()).toHaveLength(0);
		} finally {
			delivery.stopWakeTicker();
			store.close();
		}
	});
});
