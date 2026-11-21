import { describe, expect, test } from "bun:test";
import { wireDelivery } from "./delivery.ts";
import { openStore } from "../conversation.ts";
import { openTurnJournal } from "../turn-journal.ts";
import { openWakeStore } from "../wake-store.ts";
import type { Runtime } from "../runtime.ts";

describe("boot delivery", () => {
	test("holds persisted wakes until dispatcher.start()", () => {
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
		const journal = openTurnJournal(store.db);
		const submitted: string[] = [];
		const runtime = {
			accepting: () => true,
			isAdmitted: () => false,
			submitPersisted: (conversation: { id: string }) => {
				submitted.push(conversation.id);
				return true;
			},
		} as unknown as Runtime;
		const delivery = wireDelivery({
			store,
			runtime,
			journal,
			wakes,
			configRef: { current: { operators: [], telegram: {} } } as never,
			auth: {} as never,
			push: { notifyDone: async () => false } as never,
			gate: null,
			programs: {} as never,
		});
		let stop = () => {};

		try {
			expect(submitted).toEqual([]);
			stop = delivery.dispatcher.start();
			expect(submitted).toEqual([conv.id]);
			expect(wakes.pending()).toHaveLength(0);
		} finally {
			stop();
			store.close();
		}
	});
});
