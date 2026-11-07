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
