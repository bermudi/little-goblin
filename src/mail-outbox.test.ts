// The outbox's invariants: send queues a pending row with a 24h fuse,
// decisions are compare-and-set (one winner between a tap and the
// sweeper), and expiry only ever takes pending rows.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOutbox, OUTBOX_TTL_MS, type OutboxStore } from "./mail-outbox.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-outbox-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const NOW = new Date("2026-09-26T10:00:00.000Z");
const ADDRESS = { chatId: -100, threadId: 7 };

function store(): OutboxStore {
	return openOutbox(tmpdb());
}

describe("mail outbox", () => {
	test("queue writes a pending row with a 24h fuse", () => {
		const s = store();
		const row = s.queue(
			{ to: ["a@x.com"], subject: "hi", body: "hello", address: ADDRESS },
			NOW,
		);
		expect(row.status).toBe("pending");
		expect(row.draftMessageId).toBeNull();
		expect(row.cc).toEqual([]);
		expect(new Date(row.expiresAt).getTime() - NOW.getTime()).toBe(OUTBOX_TTL_MS);
		expect(s.get(row.id)).toEqual(row);
	});

	test("bindDraft pins the draft message; rows survive a reopen", () => {
		const path = tmpdb();
		const s = openOutbox(path);
		const row = s.queue(
			{
				to: ["a@x.com"],
				cc: ["b@y.com"],
				subject: "hi",
				body: "hello",
				replyToId: "m1",
				address: ADDRESS,
			},
			NOW,
		);
		s.bindDraft(row.id, 4242);
		s.close();
		const reopened = openOutbox(path);
		const back = reopened.get(row.id)!;
		expect(back.draftMessageId).toBe(4242);
		expect(back.cc).toEqual(["b@y.com"]);
		expect(back.replyToId).toBe("m1");
		expect(back.status).toBe("pending");
		reopened.close();
	});

	test("decide is compare-and-set — only the first decision lands", () => {
		const s = store();
		const row = s.queue({ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		expect(s.decide(row.id, "sent", NOW, "gmail-1")).toBe(true);
		// A double-tap, or the sweeper racing the tap, loses.
		expect(s.decide(row.id, "cancelled", NOW)).toBe(false);
		expect(s.decide(9999, "cancelled", NOW)).toBe(false);
		const back = s.get(row.id)!;
		expect(back.status).toBe("sent");
		expect(back.sentId).toBe("gmail-1");
		expect(back.decidedAt).toBe(NOW.toISOString());
	});

	test("expireDue takes only lapsed pending rows", () => {
		const s = store();
		const old = s.queue(
			{ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		const fresh = s.queue({ to: ["b@y.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		const done = s.queue({ to: ["c@z.com"], subject: "h", body: "b", address: ADDRESS }, new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000));
		s.decide(done.id, "cancelled", NOW);
		const expired = s.expireDue(NOW);
		expect(expired.map((r) => r.id)).toEqual([old.id]);
		expect(expired[0]!.status).toBe("expired");
		expect(s.get(fresh.id)!.status).toBe("pending");
		expect(s.get(done.id)!.status).toBe("cancelled");
	});
});
