import { expect, test } from "bun:test";
import { appAddress } from "../conversation.ts";
import type { OperatorReminder } from "../responsibility-reminder.ts";
import { openTestStore } from "../testkit.ts";
import type { DeliveryApi } from "./delivery.ts";
import { openPings } from "./pings.ts";
import { openTelegramReminders } from "./reminder.ts";

function rig(api: "up" | "down" = "up") {
	const { store } = openTestStore("goblin-tg-reminder-");
	const conv = store.resolve(appAddress("room"), "/w");
	const pings = openPings(store.db);
	const sent: { chat: number; text: string; opts: unknown }[] = [];
	const failures = { next: 0 };
	const fake = {
		sendMessage(chat: number, text: string, opts: unknown) {
			if (failures.next > 0) {
				failures.next--;
				return Promise.reject(new Error("telegram down"));
			}
			sent.push({ chat, text, opts });
			return Promise.resolve({ message_id: 100 + sent.length });
		},
	} as unknown as DeliveryApi;
	const remind = openTelegramReminders({
		db: store.db,
		pings,
		api: () => (api === "up" ? fake : null),
		operators: () => [1],
		publicUrl: () => "https://goblin.example.test",
	});
	const reminder: OperatorReminder = {
		key: "reminder:r:1:1",
		series: "reminder:r",
		responsibilityId: "r",
		conversationId: conv.id,
		stage: "question",
	};
	return { remind, reminder, sent, failures, pings };
}

test("sends once per step, links the app, and routes a swipe reply", async () => {
	const r = rig();
	await r.remind(r.reminder);
	await r.remind(r.reminder);
	expect(r.sent).toHaveLength(1);
	expect(r.sent[0]!.text).toBe("A question is still waiting for you");
	expect(JSON.stringify(r.sent[0]!.opts)).toContain("Open in app");
	expect(r.pings.lookup(1, 101)).toBe(r.reminder.conversationId);
	await r.remind({ ...r.reminder, key: "reminder:r:1:2" });
	expect(r.sent).toHaveLength(2);
});

test("a failed send retries on the next attempt", async () => {
	const r = rig();
	r.failures.next = 1;
	await r.remind(r.reminder);
	expect(r.sent).toHaveLength(0);
	await r.remind(r.reminder);
	expect(r.sent).toHaveLength(1);
});

test("a detached channel sends nothing and does not throw", async () => {
	const r = rig("down");
	await r.remind(r.reminder);
	expect(r.sent).toHaveLength(0);
});

test("a marker and reply route save together, and a storage failure propagates", async () => {
	const r = rig();
	const record = r.pings.record;
	r.pings.record = () => {
		throw new Error("disk");
	};
	await expect(r.remind(r.reminder)).rejects.toThrow("disk");
	r.pings.record = record;
	await r.remind(r.reminder);
	expect(r.sent).toHaveLength(2);
});

test("a late result after a timeout is recorded, with no second send", async () => {
	const { store } = openTestStore("goblin-tg-late-");
	const conv = store.resolve(appAddress("room"), "/w");
	const pings = openPings(store.db);
	let finish = (_: { message_id: number }) => {};
	let sends = 0;
	const remind = openTelegramReminders({
		db: store.db,
		pings,
		api: () =>
			({
				sendMessage() {
					sends++;
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
			}) as unknown as DeliveryApi,
		operators: () => [1],
		publicUrl: () => undefined,
		timeoutMs: 1,
	});
	const reminder: OperatorReminder = {
		key: "k",
		series: "s",
		responsibilityId: "r",
		conversationId: conv.id,
		stage: "question",
	};
	const delivery = remind(reminder);
	await Bun.sleep(10);
	finish({ message_id: 7 });
	await delivery;
	expect(pings.lookup(1, 7)).toBe(conv.id);
	await remind(reminder);
	expect(sends).toBe(1);
});
