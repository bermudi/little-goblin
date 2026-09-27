// The Send/Cancel decision paths: cancel stamps and settles, send
// threads and sends through the send credential, expiry and
// double-taps resolve to a single verdict, and failures keep the row
// pending with the reason in the chat.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { MailReader, MailSender } from "../mail.ts";
import { openOutbox, OUTBOX_TTL_MS, type OutboxStore } from "../mail-outbox.ts";
import {
	handleMailApproval,
	MAIL_CANCEL_PREFIX,
	MAIL_SEND_PREFIX,
	postMailDraft,
	type MailApprovalDeps,
} from "./mail-approval.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-mailtap-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
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

// The threading lookup rides the reader — a read, never the send token.
function fakeReader(
	over: Partial<Pick<MailReader, "threadFor">> = {},
): MailReader & { threaded: string[] } {
	const threaded: string[] = [];
	return {
		search: async () => [],
		read: async () => {
			throw new Error("unreachable");
		},
		attachment: async () => new Uint8Array(),
		poll: async () => ({ hits: [], historyId: "1" }),
		profileHistoryId: async () => "1",
		threaded,
		threadFor: async (id) => {
			threaded.push(id);
			return { threadId: "thread-1", messageId: "<orig@mail>" };
		},
		...over,
	};
}

function setup(
	sender: MailSender | null = fakeSender(),
	reader: MailReader | null = fakeReader(),
): {
	outbox: OutboxStore;
	calls: ApiCalls;
	deps: MailApprovalDeps;
} {
	const outbox = openOutbox(tmpdb());
	const calls: ApiCalls = { answers: [], edits: [], markups: [], sends: [] };
	return {
		outbox,
		calls,
		deps: { api: fakeApi(calls), outbox, sender: () => sender, reader: () => reader, now: () => NOW },
	};
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

describe("postMailDraft", () => {
	test("short drafts post once with Send/Cancel", async () => {
		const { calls, deps } = setup();
		const id = await postMailDraft(deps.api, ADDRESS, 3, "draft body");
		expect(calls.sends).toHaveLength(1);
		expect(calls.sends[0]).toMatchObject({ chat: -100, text: "draft body", keyboard: true });
		expect(id).toBe(501);
		deps.outbox.close();
	});

	test("long drafts chunk, buttons on the last, truncation marked", async () => {
		const { calls, deps } = setup();
		const text = `${"para\n".repeat(5000)}tail`;
		const id = await postMailDraft(deps.api, ADDRESS, 3, text);
		expect(calls.sends.length).toBeGreaterThan(1);
		expect(calls.sends.length).toBeLessThanOrEqual(4);
		expect(calls.sends.slice(0, -1).every((s) => !s.keyboard)).toBe(true);
		expect(calls.sends.at(-1)!.keyboard).toBe(true);
		expect(calls.sends.at(-1)!.text).toContain("truncated for Telegram");
		expect(id).toBe(500 + calls.sends.length);
		deps.outbox.close();
	});
});

describe("mail approval taps", () => {
	test("cancel settles the row and stamps the draft", async () => {
		const { outbox, calls, deps } = setup();
		const row = queue(outbox);
		await handleMailApproval(tap(row.id, "cancel"), deps);
		expect(outbox.get(row.id)!.status).toBe("cancelled");
		expect(calls.answers).toEqual([{ id: `q-cancel-${row.id}`, text: "cancelled" }]);
		expect(calls.edits).toHaveLength(1);
		expect(calls.edits[0]!.text).toContain("cancelled — never sent");
		outbox.close();
	});

	test("send threads nothing without a reply target, then stamps sent", async () => {
		const { outbox, calls, deps } = setup();
		const sender = fakeSender();
		deps.sender = () => sender;
		const row = queue(outbox);
		await handleMailApproval(tap(row.id, "send"), deps);
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
		const { outbox, deps } = setup(sender, reader);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "m9", address: ADDRESS },
			NOW,
		);
		await handleMailApproval(tap(row.id, "send"), deps);
		expect(reader.threaded).toEqual(["m9"]);
		expect(sender.sent[0]).toMatchObject({ threadId: "thread-1", inReplyTo: "<orig@mail>" });
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("a vanished reply target keeps the row pending with a notice", async () => {
		const reader = fakeReader({ threadFor: async () => null });
		const { outbox, calls, deps } = setup(fakeSender(), reader);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "ghost", address: ADDRESS },
			NOW,
		);
		await handleMailApproval(tap(row.id, "send"), deps);
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
		const { outbox, calls, deps } = setup(fakeSender(), reader);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "m9", address: ADDRESS },
			NOW,
		);
		await handleMailApproval(tap(row.id, "send"), deps);
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("tap Send to retry");
		outbox.close();
	});

	test("a missing reader keeps a reply draft pending with a notice", async () => {
		const { outbox, calls, deps } = setup(fakeSender(), null);
		const row = outbox.queue(
			{ to: ["a@x.com"], subject: "re", body: "b", replyToId: "m9", address: ADDRESS },
			NOW,
		);
		await handleMailApproval(tap(row.id, "send"), deps);
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
		const { outbox, calls, deps } = setup(sender);
		const row = queue(outbox);
		await handleMailApproval(tap(row.id, "send"), deps);
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("tap Send to retry");
		outbox.close();
	});

	test("an expired draft settles expired, never sent", async () => {
		const sender = fakeSender();
		const { outbox, calls, deps } = setup(sender);
		const row = queue(outbox, new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000));
		await handleMailApproval(tap(row.id, "send"), deps);
		expect(sender.sent).toHaveLength(0);
		expect(outbox.get(row.id)!.status).toBe("expired");
		expect(calls.edits[0]!.text).toContain("expired — never sent");
		outbox.close();
	});

	test("a tap on a settled row strips the buttons and says so", async () => {
		const { outbox, calls, deps } = setup();
		const row = queue(outbox);
		outbox.decide(row.id, "cancelled", NOW);
		await handleMailApproval(tap(row.id, "send"), deps);
		expect(calls.answers).toEqual([{ id: `q-send-${row.id}`, text: "already cancelled" }]);
		expect(calls.markups).toHaveLength(1);
		outbox.close();
	});

	test("a tap on a missing draft toasts and touches nothing", async () => {
		const { calls, deps } = setup();
		await handleMailApproval(tap(9999, "send"), deps);
		expect(calls.answers).toEqual([{ id: "q-send-9999", text: "draft gone" }]);
		expect(calls.sends).toHaveLength(0);
		deps.outbox.close();
	});

	test("a second tap inside a slow send toasts instead of double-sending", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async (draft) => {
				await gate;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, deps } = setup(sender);
		const row = queue(outbox);
		const first = handleMailApproval({ ...tap(row.id, "send"), id: "q-first" }, deps);
		await Bun.sleep(10);
		await handleMailApproval({ ...tap(row.id, "send"), id: "q-second" }, deps);
		release();
		await first;
		expect(calls.answers).toContainEqual({ id: "q-second", text: "sending — wait for the verdict" });
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("cancel during a slow send is refused — the send's verdict wins", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async (draft) => {
				await gate;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, deps } = setup(sender);
		const row = queue(outbox);
		const first = handleMailApproval({ ...tap(row.id, "send"), id: "q-first" }, deps);
		await Bun.sleep(10);
		await handleMailApproval({ ...tap(row.id, "cancel"), id: "q-cancel" }, deps);
		release();
		await first;
		expect(calls.answers).toContainEqual({ id: "q-cancel", text: "sending — wait for the verdict" });
		expect(calls.edits[0]!.text).toContain("sent to a@x.com");
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("a fuse burning out mid-send can't expire the row — the send decides it", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const sender = fakeSender({
			send: async (draft) => {
				await gate;
				return { id: "gmail-1", threadId: "t" };
			},
		});
		const { outbox, calls, deps } = setup(sender);
		// Queued a minute ago — the 24h fuse is still burning at tap time.
		const row = queue(outbox, new Date(NOW.getTime() - 60_000));
		let clock = NOW;
		deps.now = () => clock;
		const first = handleMailApproval({ ...tap(row.id, "send"), id: "q-first" }, deps);
		await Bun.sleep(10);
		// The fuse runs out while the Gmail send is in flight.
		clock = new Date(NOW.getTime() + OUTBOX_TTL_MS + 60_000);
		await handleMailApproval({ ...tap(row.id, "send"), id: "q-late" }, deps);
		release();
		await first;
		expect(calls.answers).toContainEqual({ id: "q-late", text: "sending — wait for the verdict" });
		expect(outbox.get(row.id)!.status).toBe("sent");
		outbox.close();
	});

	test("unconfigured mail keeps the draft with a notice", async () => {
		const { outbox, calls, deps } = setup(null);
		const row = queue(outbox);
		await handleMailApproval(tap(row.id, "send"), deps);
		expect(outbox.get(row.id)!.status).toBe("pending");
		expect(calls.sends[0]!.text).toContain("not configured");
		outbox.close();
	});
});
