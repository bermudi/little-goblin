import { describe, expect, test } from "bun:test";
import { describeMailDecision, type MailDecision } from "./mail-approval.ts";
import type { OutboxEntry } from "./mail-outbox.ts";

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
