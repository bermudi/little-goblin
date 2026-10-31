import { describe, expect, test } from "bun:test";
import {
	describeMailDecision,
	startMailApproval,
	type MailApproval,
	type MailApprovalLane,
	type MailDecision,
} from "./mail-approval.ts";
import { openOutbox, OUTBOX_TTL_MS, type OutboxEntry, type OutboxStore } from "./mail-outbox.ts";
import { APP_ACTOR } from "./targets.ts";
import { tmpDb } from "./testkit.ts";

const row: OutboxEntry = {
	id: 1,
	to: ["a@x.com"],
	cc: [],
	subject: "hi",
	body: "hello",
	replyToId: null,
	target: "app:app-1",
	chatId: 0,
	threadId: null,
	draftMessageId: null,
	status: "cancelled",
	createdAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2026-01-02T00:00:00.000Z",
	decidedAt: null,
	sentId: null,
	decidedBy: null,
};

describe("send crash window", () => {
	const T0 = new Date("2026-01-01T00:00:00.000Z");

	interface CrashHarness {
		outbox: OutboxStore;
		approval: MailApproval;
		settles: string[];
		delivered: number;
		setNow(d: Date): void;
		setCrash(v: boolean): void;
	}

	function crashHarness(): CrashHarness {
		const real = openOutbox(tmpDb("goblin-mail-crash-"));
		let crash = false;
		let delivered = 0;
		let now = T0;
		const settles: string[] = [];
		const outbox: OutboxStore = {
			...real,
			completeSend: (id, sentId, at, actor) => {
				if (crash) throw new Error("simulated crash after Gmail accepted the send");
				return real.completeSend(id, sentId, at, actor);
			},
		};
		const lane: MailApprovalLane = {
			present: async () => ({ kind: "posted", messageId: null, surface: "test" }),
			notice: async () => {},
			settle: async (_row, text) => {
				settles.push(text);
			},
			strip: async () => {},
		};
		const approval = startMailApproval(
			{
				outbox,
				sender: () => ({
					send: async () => {
						delivered++;
						return { id: "gmail-1", threadId: "t-1" };
					},
				}),
				reader: () => null,
				lanes: { app: lane, telegram: lane },
				now: () => now,
			},
			60_000,
		);
		return {
			outbox,
			approval,
			settles,
			get delivered() {
				return delivered;
			},
			setNow: (d) => {
				now = d;
			},
			setCrash: (v) => {
				crash = v;
			},
		} as CrashHarness;
	}

	test("a crash between the Gmail send and recording it never stamps 'never sent'", async () => {
		const h = crashHarness();
		try {
			const row = h.outbox.queue(
				{ to: ["a@x.com"], subject: "hi", body: "hello", address: { target: "app/app-1" } },
				T0,
			);
			h.setCrash(true);
			await expect(h.approval.decide(row.id, "send", APP_ACTOR)).rejects.toThrow("simulated crash");
			expect(h.delivered).toBe(1); // Gmail accepted it
			// The intent was recorded before the send: the row is claimed,
			// not pending, so no later sweep can call it "never sent".
			expect(h.outbox.get(row.id)!.status).toBe("sending");
			h.setNow(new Date(T0.getTime() + OUTBOX_TTL_MS + 1000));
			await h.approval.sweep();
			expect(h.outbox.get(row.id)!.status).toBe("sending");
			expect(h.settles.some((t) => t.includes("never sent"))).toBe(false);
			// A re-tap refuses to resend while the verdict is unknown…
			const again = await h.approval.decide(row.id, "send", APP_ACTOR);
			expect(again.kind).toBe("busy");
			expect(h.delivered).toBe(1);
			// …and the operator can abandon the claim explicitly.
			const cancelled = await h.approval.decide(row.id, "cancel", APP_ACTOR);
			expect(cancelled.kind).toBe("cancelled");
			expect(h.outbox.get(row.id)!.status).toBe("cancelled");
		} finally {
			await h.approval.stop();
			h.outbox.close();
		}
	});

	test("a claimed send completes as sent with the Gmail id", async () => {
		const h = crashHarness();
		try {
			const row = h.outbox.queue(
				{ to: ["a@x.com"], subject: "hi", body: "hello", address: { target: "app/app-1" } },
				T0,
			);
			const outcome = await h.approval.decide(row.id, "send", APP_ACTOR);
			expect(outcome.kind).toBe("sent");
			const back = h.outbox.get(row.id)!;
			expect(back.status).toBe("sent");
			expect(back.sentId).toBe("gmail-1");
		} finally {
			await h.approval.stop();
			h.outbox.close();
		}
	});
});

describe("describeMailDecision", () => {
	test("one shared wording for every decision kind", () => {
		const cases: [MailDecision, string][] = [
			[{ kind: "gone" }, "draft gone"],
			[{ kind: "settled", row }, "already cancelled"],
			[{ kind: "busy", row }, "sending — wait for the verdict"],
			[{ kind: "expired", row }, "draft expired"],
			[{ kind: "cancelled", row }, "cancelled"],
			[{ kind: "sent", row }, "sent"],
			[{ kind: "retry", row, message: "raw upstream detail" }, "send failed — see the notice"],
			[{ kind: "conflict", row }, "send raced another decision"],
		];
		for (const [outcome, text] of cases) expect(describeMailDecision(outcome)).toBe(text);
	});
});
