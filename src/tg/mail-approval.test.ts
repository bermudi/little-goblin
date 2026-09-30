// The send gate's contract: a draft request queues, posts, and binds
// as one unit — a definite Telegram post failure cancels and answers
// retryable; a timeout stays pending — the Send/Cancel taps decide
// (cancel stamps and settles, send threads through the send credential,
// expiry and
// double-taps resolve to a single verdict, failures keep the row
// pending with the reason in the chat), and the sweep settles expired
// drafts without ever claiming a row mid-send.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { TelegramTimeoutError } from "./deadline.ts";
import type { MailPoller, MailSender } from "../mail.ts";
import { openOutbox, OUTBOX_TTL_MS, type OutboxStore } from "../mail-outbox.ts";
import {
	MAIL_CANCEL_PREFIX,
	MAIL_SEND_PREFIX,
	chunkDraft,
	startMailApproval,
	type MailApproval,
	type MailApprovalDeps,
} from "./mail-approval.ts";

test("draft chunk boundaries never split an emoji", () => {
	const chunks = chunkDraft(`${"x".repeat(3799)}🙂tail`);
	expect(chunks).toHaveLength(2);
	expect(chunks.join("")).toBe(`${"x".repeat(3799)}🙂tail`);
	expect(chunks[0]?.endsWith("🙂")).toBe(false);
	expect(chunks[1]?.startsWith("🙂")).toBe(true);
});

let dirs: string[] = [];
let gates: MailApproval[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-mailtap-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const g of gates) g.stop();
	gates = [];
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const NOW = new Date("2026-09-26T10:00:00.000Z");
const ADDRESS = { chatId: -100, threadId: 7 };

interface ApiCalls {
	answers: Array<{ id: string; text?: string }>;
	edits: Array<{ chat: number; message: number; text: string }>;
	markups: Array<{ chat: number; message: number }>;
	sends: Array<{ chat: number; text: string; keyboard: boolean }>;
}

function fakeApi(calls: ApiCalls, messageId = 500): Api {
	return {
		answerCallbackQuery: async (id: string, opts?: { text?: string }) => {
			calls.answers.push({ id, ...(opts?.text !== undefined ? { text: opts.text } : {}) });
			return true;
		},
		editMessageText: async (chat: number, message: number, text: string) => {
			calls.edits.push({ chat, message, text });
			return { message_id: message } as never;
		},
		editMessageReplyMarkup: async (chat: number, message: number) => {
			calls.markups.push({ chat, message });
			return { message_id: message } as never;
		},
		sendMessage: async (chat: number, text: string, extra?: { reply_markup?: unknown }) => {
			calls.sends.push({ chat, text, keyboard: extra?.reply_markup !== undefined });
			return { message_id: messageId + calls.sends.length } as never;
		},
	} as unknown as Api;
}

function fakeSender(over: Partial<MailSender> = {}): MailSender & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		sent,
		send: async (draft) => {
			sent.push(draft);
			return { id: "gmail-1", threadId: "thread-1" };
		},
		...over,
	};
}

// The threading lookup rides the gws poller — a read, never the send token.
function fakeReader(
	over: Partial<Pick<MailPoller, "threadFor">> = {},
): MailPoller & { threaded: string[] } {
	const threaded: string[] = [];
	return {
		poll: async () => ({ hits: [], historyId: "1" }),
		profileHistoryId: async () => "1",
		threaded,
		threadFor: async (id: string) => {
			threaded.push(id);
			return { threadId: "thread-1", messageId: "<orig@mail>" };
		},
		...over,
	};
}

function setup(
	sender: MailSender | null = fakeSender(),
	reader: MailPoller | null = fakeReader(),
	outbox: OutboxStore = openOutbox(tmpdb()),
): {
	outbox: OutboxStore;
	calls: ApiCalls;
	deps: MailApprovalDeps;
	gate: MailApproval;
} {
	const calls: ApiCalls = { answers: [], edits: [], markups: [], sends: [] };
	const deps: MailApprovalDeps = {
		api: fakeApi(calls),
		outbox,
		sender: () => sender,
		reader: () => reader,
		now: () => NOW,
	};
	// Long tick: the timer never fires mid-test; the sweep is driven
	// through gate.sweep(). Built on an empty outbox, so the boot
	// catch-up sweep is a no-op for every tap test.
	const gate = startMailApproval(deps, 60_000);
	gates.push(gate);
	return { outbox, calls, deps, gate };
}

function queue(s: OutboxStore, at: Date = NOW) {
	return s.queue(
		{ to: ["a@x.com"], subject: "hi", body: "hello", address: ADDRESS },
		at,
	);
}

const tap = (id: number, op: "send" | "cancel") => ({
	id: `q-${op}-${id}`,
	data: `${op === "send" ? MAIL_SEND_PREFIX : MAIL_CANCEL_PREFIX}${id}`,
	message: { message_id: 500, chat: { id: -100 } },
});

describe("draft requests", () => {
	test("a request queues, posts, and binds as one unit", async () => {
		const { outbox, calls, gate } = setup();
		const out = await gate.requestDraft(
			{ to: ["a@x.com"], cc: ["b@y.com"], subject: "hi", body: "hello", replyToId: "m9" },
			ADDRESS,
		);
		if (!("queued" in out)) throw new Error("expected a queued verdict");
		expect(out.status).toContain("awaiting operator approval");
		const row = outbox.get(out.queued)!;
		expect(row.status).toBe("pending");
		expect(row.to).toEqual(["a@x.com"]);
		expect(row.cc).toEqual(["b@y.com"]);
		expect(row.subject).toBe("hi");
		expect(row.body).toBe("hello");
		expect(row.replyToId).toBe("m9");
		expect(row.chatId).toBe(-100);
		expect(row.threadId).toBe(7);
		// The buttons' message id is bound onto the row.
		expect(row.draftMessageId).toBe(501);
		expect(calls.sends).toHaveLength(1);
		expect(calls.sends[0]).toMatchObject({ chat: -100, keyboard: true });
		// The posted draft renders the queued content.
		expect(calls.sends[0]!.text).toContain(`Draft #${row.id}`);
		expect(calls.sends[0]!.text).toContain("To: a@x.com");
		expect(calls.sends[0]!.text).toContain("Cc: b@y.com");
		expect(calls.sends[0]!.text).toContain("Subject: hi");
		expect(calls.sends[0]!.text).toContain("Reply to: m9");
		expect(calls.sends[0]!.text).toContain("hello");
		outbox.close();
	});

	test("the queued row's id is the buttons' id — request then tap sends", async () => {
		const { outbox, calls, gate } = setup();
		const out = await gate.requestDraft({ to: ["a@x.com"], subject: "hi", body: "hello" }, ADDRESS);
		if (!("queued" in out)) throw new Error("expected a queued verdict");
		await gate.handleTap(tap(out.queued, "send"));
		expect(outbox.get(out.queued)!.status).toBe("sent");
		expect(calls.edits[0]!.text).toContain("sent to a@x.com");
		outbox.close();
	});

	test("long drafts chunk, buttons on the last, truncation marked", async () => {
		const { outbox, calls, gate } = setup();
		const text = `${"para\n".repeat(5000)}tail`;
		const out = await gate.requestDraft({ to: ["a@x.com"], subject: "hi", body: text }, ADDRESS);
		const row = outbox.get((out as { queued: number }).queued)!;
		expect(calls.sends.length).toBeGreaterThan(1);
		expect(calls.sends.length).toBeLessThanOrEqual(4);
		expect(calls.sends.slice(0, -1).every((s) => !s.keyboard)).toBe(true);
		expect(calls.sends.at(-1)!.keyboard).toBe(true);
		expect(calls.sends.at(-1)!.text).toContain("truncated for Telegram");
		expect(row.draftMessageId).toBe(500 + calls.sends.length);
		outbox.close();
	});

	test("an accepted draft whose button post times out stays pending and its unbound button still sends", async () => {
		const sender = fakeSender();
		const { outbox, calls, deps, gate } = setup(sender);
		// Telegram accepted the message (with buttons) but the response was
		// lost. A callback can arrive even though no message id was bound.
		deps.api = {
			...deps.api,
			sendMessage: async (chat: number, text: string, extra?: { reply_markup?: unknown }) => {
				calls.sends.push({ chat, text, keyboard: extra?.reply_markup !== undefined });
				throw new TelegramTimeoutError("sendMessage", 30_000);
			},
		} as unknown as Api;
		const out = await gate.requestDraft({ to: ["a@x.com"], subject: "hi", body: "hello" }, ADDRESS);
		if (!("queued" in out)) throw new Error("expected uncertain queued verdict");
		expect(out.status).toContain(`draft #${out.queued}`);
		expect(out.status).toContain("uncertain");
		expect(out.status).toContain("check Telegram before retrying");
		expect(out.status).not.toContain("cancelled");
		expect(calls.sends).toHaveLength(1);
		expect(calls.sends[0]!.keyboard).toBe(true);
		expect(calls.sends[0]!.text).toContain(`Draft #${out.queued}`);
		expect(outbox.get(out.queued)).toMatchObject({
			status: "pending", draftMessageId: null, decidedAt: null,
		});
		await gate.handleTap(tap(out.queued, "send"));
		expect(sender.sent).toHaveLength(1);
		expect(outbox.get(out.queued)!.status).toBe("sent");
		expect(calls.edits).toContainEqual({
			chat: -100, message: 500, text: expect.stringContaining("sent to a@x.com"),
		});
		outbox.close();
	});

	test("a timeout on a later draft chunk does not cancel or post more chunks", async () => {
		const { outbox, calls, deps, gate } = setup();
		deps.api = {
			...deps.api,
			sendMessage: async (chat: number, text: string, extra?: { reply_markup?: unknown }) => {
				calls.sends.push({ chat, text, keyboard: extra?.reply_markup !== undefined });
				if (calls.sends.length === 2) throw new TelegramTimeoutError("sendMessage", 30_000);
				return { message_id: 500 + calls.sends.length } as never;
			},
		} as unknown as Api;
		const out = await gate.requestDraft(
			{ to: ["a@x.com"], subject: "hi", body: "x".repeat(4000) }, ADDRESS,
		);
		if (!("queued" in out)) throw new Error("expected uncertain queued verdict");
		expect(out.status).toContain("check Telegram before retrying");
		expect(calls.sends.map((s) => s.keyboard)).toEqual([false, true]);
		expect(outbox.get(out.queued)).toMatchObject({
			status: "pending", draftMessageId: null, decidedAt: null,
		});
		outbox.close();
	});

	test("a timeout before the buttons chunk cancels — no tap can ever decide the row", async () => {
		const store = openOutbox(tmpdb());
		let seenId = 0;
		const outbox: OutboxStore = {
			...store,
			queue: (input, now) => {
				const row = store.queue(input, now);
				seenId = row.id;
				return row;
			},
		};
		const { calls, deps, gate } = setup(fakeSender(), fakeReader(), outbox);
		deps.api = {
			...deps.api,
			sendMessage: async (chat: number, text: string, extra?: { reply_markup?: unknown }) => {
				calls.sends.push({ chat, text, keyboard: extra?.reply_markup !== undefined });
				// Three-chunk draft; the second (non-buttons) chunk's response
				// is lost — posting stops before the buttons ever run.
				if (calls.sends.length === 2) throw new TelegramTimeoutError("sendMessage", 30_000);
				return { message_id: 500 + calls.sends.length } as never;
			},
		} as unknown as Api;
		const out = await gate.requestDraft(
			{ to: ["a@x.com"], subject: "hi", body: "x".repeat(8000) }, ADDRESS,
		);
		if (!("error" in out)) throw new Error("expected a cancelled error verdict");
		expect(out.error).toContain(`draft #${seenId}`);
		expect(out.error).toContain("cancelled");
		// Stopped at the timed-out chunk — the buttons chunk never ran.
		expect(calls.sends.map((s) => s.keyboard)).toEqual([false, false]);
		expect(outbox.get(seenId)).toMatchObject({ status: "cancelled", draftMessageId: null });
		outbox.close();
	});

	test("a failed draft post cancels the row and returns a retryable error", async () => {
		const store = openOutbox(tmpdb());
		let seenId = 0;
		const outbox: OutboxStore = {
			...store,
			queue: (input, now) => {
				const row = store.queue(input, now);
				seenId = row.id;
				return row;
			},
		};
		const calls: ApiCalls = { answers: [], edits: [], markups: [], sends: [] };
		const api = {
			...fakeApi(calls),
			sendMessage: async () => {
				throw new Error("telegram: HTTP 502");
			},
		} as unknown as Api;
		const gate = startMailApproval(
			{ api, outbox, sender: () => fakeSender(), reader: () => fakeReader(), now: () => NOW },
			60_000,
		);
		gates.push(gate);
		const out = await gate.requestDraft({ to: ["a@x.com"], subject: "hi", body: "hello" }, ADDRESS);
		if (!("error" in out)) throw new Error("expected an error verdict");
		expect(out.error).toBe(
			"posting the draft to Telegram failed — the draft was cancelled; retry the send when delivery recovers",
		);
		// No orphan: the queued row is settled cancelled, not pending
		// for 24h with no buttons anywhere.
		const row = outbox.get(seenId)!;
		expect(row.status).toBe("cancelled");
		expect(row.decidedAt).not.toBeNull();
		expect(row.draftMessageId).toBeNull();
		outbox.close();
	});
});

describe("mail approval taps", () => {
	test("cancel settles the row and stamps the draft", async () => {
		const { outbox, calls, gate } = setup();
		const row = queue(outbox);
		await gate.handleTap(tap(row.id, "cancel"));
		expect(outbox.get(row.id)!.status).toBe("cancelled");
		expect(calls.answers).toEqual([{ id: `q-cancel-${row.id}`, text: "cancelled" }]);
		expect(calls.edits).toHaveLength(1);
		expect(calls.edits[0]!.text).toContain("cancelled — never sent");
		outbox.close();
	});

	test("send threads nothing without a reply target, then stamps sent", async () => {
		const { outbox, calls, deps, gate } = setup();
		const sender = fakeSender();
		deps.sender = () => sender;
		const row = queue(outbox);
		await gate.handleTap(tap(row.id, "send"));
		expect(sender.sent).toHaveLength(1);
		expect(sender.sent[0]).toMatchObject({ to: ["a@x.com"], subject: "hi", body: "hello" });
		expect(sender.sent[0]).not.toHaveProperty("threadId");
		const back = outbox.get(row.id)!;
		expect(back.status).toBe("sent");
		expect(back.sentId).toBe("gmail-1");
		expect(calls.answers).toEqual([{ id: `q-send-${row.id}` }]);
		expect(calls.edits[0]!.text).toContain("sent to a@x.com");
		outbox.close();
	});

	test("a reply resolves threading at send time through the reader", async () => {
		const sender = fakeSender();
		const reader = fakeReader();
		const { outbox, gate } = setup(sender, reader);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "m9", address: ADDRESS },
			NOW,
		);
		await gate.handleTap(tap(row.id, "send"));
		expect(reader.threaded).toEqual(["m9"]);
		expect(sender.sent[0]).toMatchObject({ threadId: "thread-1", inReplyTo: "<orig@mail>" });
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("a vanished reply target keeps the row pending with a notice", async () => {
		const reader = fakeReader({ threadFor: async () => null });
		const { outbox, calls, gate } = setup(fakeSender(), reader);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "ghost", address: ADDRESS },
			NOW,
		);
		await gate.handleTap(tap(row.id, "send"));
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends).toHaveLength(1);
		expect(calls.sends[0]!.text).toContain("message this answers is gone");
		outbox.close();
	});

	test("a threading lookup failure keeps the row pending with a retry notice", async () => {
		const reader = fakeReader({
			threadFor: async () => {
				throw new Error("gmail: HTTP 500");
			},
		});
		const { outbox, calls, gate } = setup(fakeSender(), reader);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "m9", address: ADDRESS },
			NOW,
		);
		await gate.handleTap(tap(row.id, "send"));
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("tap Send to retry");
		outbox.close();
	});

	test("a missing reader keeps a reply draft pending with a notice", async () => {
		const { outbox, calls, gate } = setup(fakeSender(), null);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "m9", address: ADDRESS },
			NOW,
		);
		await gate.handleTap(tap(row.id, "send"));
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("couldn't thread the reply");
		outbox.close();
	});

	test("a Gmail failure keeps the row pending with a retry notice", async () => {
		const sender = fakeSender({
			send: async () => {
				throw new Error("gmail: HTTP 500");
			},
		});
		const { outbox, calls, gate } = setup(sender);
		const row = queue(outbox);
		await gate.handleTap(tap(row.id, "send"));
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("tap Send to retry");
		outbox.close();
	});

	test("an expired draft settles expired, never sent", async () => {
		const sender = fakeSender();
		const { outbox, calls, gate } = setup(sender);
		const row = queue(outbox, new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000));
		await gate.handleTap(tap(row.id, "send"));
		expect(sender.sent).toHaveLength(0);
		expect(outbox.get(row.id)!.status).toBe("expired");
		expect(calls.edits[0]!.text).toContain("expired — never sent");
		outbox.close();
	});

	test("a tap on a settled row strips the buttons and says so", async () => {
		const { outbox, calls, gate } = setup();
		const row = queue(outbox);
		outbox.decide(row.id, "cancelled", NOW);
		await gate.handleTap(tap(row.id, "send"));
		expect(calls.answers).toEqual([{ id: `q-send-${row.id}`, text: "already cancelled" }]);
		expect(calls.markups).toHaveLength(1);
		outbox.close();
	});

	test("a tap on a missing draft toasts and touches nothing", async () => {
		const { outbox, calls, gate } = setup();
		await gate.handleTap(tap(9999, "send"));
		expect(calls.answers).toEqual([{ id: "q-send-9999", text: "draft gone" }]);
		expect(calls.sends).toHaveLength(0);
		outbox.close();
	});

	test("a second tap inside a slow send toasts instead of double-sending", async () => {
		let release!: () => void;
		const gatePromise = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async () => {
				await gatePromise;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, gate } = setup(sender);
		const row = queue(outbox);
		const first = gate.handleTap({ ...tap(row.id, "send"), id: "q-first" });
		await Bun.sleep(10);
		await gate.handleTap({ ...tap(row.id, "send"), id: "q-second" });
		release();
		await first;
		expect(calls.answers).toContainEqual({ id: "q-second", text: "sending — wait for the verdict" });
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("cancel during a slow send is refused — the send's verdict wins", async () => {
		let release!: () => void;
		const gatePromise = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async () => {
				await gatePromise;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, gate } = setup(sender);
		const row = queue(outbox);
		const first = gate.handleTap({ ...tap(row.id, "send"), id: "q-first" });
		await Bun.sleep(10);
		await gate.handleTap({ ...tap(row.id, "cancel"), id: "q-cancel" });
		release();
		await first;
		expect(calls.answers).toContainEqual({ id: "q-cancel", text: "sending — wait for the verdict" });
		expect(calls.edits[0]!.text).toContain("sent to a@x.com");
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("a fuse burning out mid-send can't expire the row — the send decides it", async () => {
		let release!: () => void;
		const gatePromise = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async () => {
				await gatePromise;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, deps, gate } = setup(sender);
		// Queued a minute ago — the 24h fuse is still burning at tap time.
		const row = queue(outbox, new Date(NOW.getTime() - 60_000));
		let clock = NOW;
		deps.now = () => clock;
		const first = gate.handleTap({ ...tap(row.id, "send"), id: "q-first" });
		await Bun.sleep(10);
		// The fuse runs out while the Gmail send is in flight.
		clock = new Date(NOW.getTime() + OUTBOX_TTL_MS + 60_000);
		await gate.handleTap({ ...tap(row.id, "send"), id: "q-late" });
		release();
		await first;
		expect(calls.answers).toContainEqual({ id: "q-late", text: "sending — wait for the verdict" });
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("unconfigured mail keeps the draft with a notice", async () => {
		const { outbox, calls, gate } = setup(null);
		const row = queue(outbox);
		await gate.handleTap(tap(row.id, "send"));
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("not configured");
		outbox.close();
	});
});

describe("the expiry sweep", () => {
	test("the sweep stamps expired drafts and leaves the rest", async () => {
		const { outbox, calls, gate } = setup();
		const old = queue(outbox, new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000));
		outbox.bindDraft(old.id, 555);
		const fresh = outbox.queue({ to: ["b@y.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		await gate.sweep();
		expect(outbox.get(old.id)!.status).toBe("expired");
		expect(outbox.get(fresh.id)!.status).toBe("pending");
		expect(calls.edits).toEqual([
			{ chat: -100, message: 555, text: expect.stringContaining("expired") },
		]);
		outbox.close();
	});

	test("a sweep racing a slow send refuses the row — the send's verdict wins", async () => {
		let release!: () => void;
		const gatePromise = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async () => {
				await gatePromise;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, deps, gate } = setup(sender);
		// Queued a minute ago — the fuse is burning, not burnt, at tap time.
		const row = queue(outbox, new Date(NOW.getTime() - 60_000));
		let clock = NOW;
		deps.now = () => clock;
		const first = gate.handleTap({ ...tap(row.id, "send"), id: "q-first" });
		await Bun.sleep(10);
		// The fuse runs out while the Gmail send is in flight; the sweep
		// must refuse the mid-send row instead of stamping a lie.
		clock = new Date(NOW.getTime() + OUTBOX_TTL_MS + 60_000);
		await gate.sweep();
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.edits).toHaveLength(0);
		release();
		await first;
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("a restart: a fresh gate over the same store settles what expired while down", async () => {
		const outbox = openOutbox(tmpdb());
		// Left behind by the previous process: one past its fuse, one
		// still pending with live buttons.
		const stale = outbox.queue(
			{ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		outbox.bindDraft(stale.id, 555);
		const pending = outbox.queue({ to: ["b@y.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		const { calls, gate } = setup(fakeSender(), fakeReader(), outbox);
		// The boot catch-up runs inside the factory — the stale row is
		// already settled when it returns; give its stamp a beat to land.
		expect(outbox.get(stale.id)!.status).toBe("expired");
		await Bun.sleep(10);
		expect(calls.edits).toContainEqual({
			chat: -100,
			message: 555,
			text: expect.stringContaining("expired — never sent"),
		});
		// The sending set starts empty (factory state, not module
		// state): pending rows keep their buttons and a tap decides.
		await gate.handleTap(tap(pending.id, "cancel"));
		expect(outbox.get(pending.id)!.status).toBe("cancelled");
		outbox.close();
	});
});
