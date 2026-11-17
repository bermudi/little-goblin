import { describe, expect, test } from "bun:test";
import { startMailApproval, type MailApprovalLane } from "./mail-approval.ts";
import { openOutbox } from "./mail-outbox.ts";
import { APP_ACTOR } from "./targets.ts";
import { tmpDb } from "./testkit.ts";

describe("mail approval crash recovery", () => {
	test("a send killed after Gmail accepts it stays sending and is never re-sent at boot", async () => {
		const path = tmpDb("goblin-mail-crash-");
		let outbox = openOutbox(path);
		const lane: MailApprovalLane = {
			present: async () => ({ kind: "posted", messageId: null, surface: "test" }),
			notice: async () => {},
			settle: async () => {},
			strip: async () => {},
		};
		let calls = 0;
		let hold = true;
		const deps = (sender: () => { send: () => Promise<{ id: string; threadId: string }> }) => ({
			outbox,
			sender,
			reader: () => null,
			lanes: { app: lane, telegram: lane },
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		let approval = startMailApproval(deps(() => ({
			send: () => {
				calls++;
				return hold
					? new Promise<never>(() => {})
					: Promise.resolve({ id: "new", threadId: "t" });
			},
		})), 60_000);
		const row = outbox.queue(
			{ to: ["a@example.com"], subject: "s", body: "b", address: { target: "app/a" } },
			new Date("2026-01-01T00:00:00Z"),
		);
		void approval.decide(row.id, "send", APP_ACTOR);
		await Bun.sleep(0);
		expect(calls).toBe(1);
		expect(outbox.get(row.id)?.status).toBe("sending");
		outbox.close();
		outbox = openOutbox(path);
		hold = false;
		approval = startMailApproval(
			deps(() => ({
				send: async () => {
					calls++;
					return { id: "new", threadId: "t" };
				},
			})),
			60_000,
		);
		await approval.sweep();
		expect(outbox.get(row.id)?.status).toBe("sending");
		expect((await approval.decide(row.id, "send", APP_ACTOR)).kind).toBe("busy");
		expect(calls).toBe(1);
		outbox.close();
	});
});
