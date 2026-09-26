// The mail draft's Send/Cancel buttons (DESIGN.md, "Email"): the send
// gate's mechanism. The tool posts the draft with these buttons; only a
// tap from an allowed user sends — through the send credential, which
// no tool path ever holds. Extracted from mod.ts so the decision paths
// (send/cancel/expired/gone, double-tap, missing original) are testable
// without a live bot.

import type { Api } from "grammy";
import type { MailSender } from "../mail.ts";
import { domainOf } from "../mail.ts";
import type { OutboxEntry, OutboxStore } from "../mail-outbox.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";

export const MAIL_SEND_PREFIX = "mail:send:";
export const MAIL_CANCEL_PREFIX = "mail:cancel:";
export const MAIL_CALLBACK_RE = /^mail:(send|cancel):(\d+)$/;

// Telegram caps a message at 4096 chars — drafts chunk below it, and
// past four chunks the draft truncates with an explicit marker rather
// than flooding the chat.
const DRAFT_CHUNK = 3800;
const MAX_DRAFT_CHUNKS = 4;

// One in-flight send per draft: the Gmail call is slow, and a second
// tap inside it would otherwise double-send. (A restart clears the
// set; a pending row stays re-tappable — the crash window is one tap.)
const sending = new Set<number>();

// Structural subset of Telegram's CallbackQuery — the fields this flow
// reads (the speak-button pattern: grammy's full type is assignable).
export interface MailApprovalQuery {
	id: string;
	data: string;
	message?: {
		message_id: number;
		chat: { id: number };
	};
}

export interface MailApprovalDeps {
	api: Api;
	outbox: OutboxStore;
	/** Live send client, or null when mail is unconfigured. */
	sender(): MailSender | null;
	/** Test door for expiry. */
	now?(): Date;
}

// Post the draft, chunked, with Send/Cancel on the last message.
// Resolves the buttons' message id for the outbox row.
export async function postMailDraft(
	api: Api,
	address: { chatId: number; threadId: number | null },
	outboxId: number,
	text: string,
): Promise<number> {
	const thread = address.threadId !== null ? { message_thread_id: address.threadId } : {};
	const chunks = chunkDraft(text);
	let messageId = 0;
	for (let i = 0; i < chunks.length; i++) {
		const last = i === chunks.length - 1;
		const sent = await withTimeout(
			api.sendMessage(address.chatId, chunks[i]!, {
				...thread,
				...(last
					? {
							reply_markup: {
								inline_keyboard: [[
									{ text: "✅ Send", callback_data: `${MAIL_SEND_PREFIX}${outboxId}` },
									{ text: "🚫 Cancel", callback_data: `${MAIL_CANCEL_PREFIX}${outboxId}` },
								]],
							},
						}
					: {}),
			}),
			"sendMessage",
		);
		messageId = sent.message_id;
	}
	log.info("mail draft posted", {
		outbox: outboxId,
		conversation: address.threadId === null ? `dm:${address.chatId}` : `topic:${address.chatId}:${address.threadId}`,
		message: messageId,
		chunks: chunks.length,
	});
	return messageId;
}

function chunkDraft(text: string): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > 0 && chunks.length < MAX_DRAFT_CHUNKS) {
		if (rest.length <= DRAFT_CHUNK) {
			chunks.push(rest);
			rest = "";
			break;
		}
		let cut = rest.lastIndexOf("\n", DRAFT_CHUNK);
		if (cut < DRAFT_CHUNK / 2) cut = DRAFT_CHUNK;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) {
		chunks[chunks.length - 1] += `\n\n[… draft truncated for Telegram — ${text.length} chars total]`;
	}
	return chunks;
}

export async function handleMailApproval(query: MailApprovalQuery, deps: MailApprovalDeps): Promise<void> {
	try {
		await decide(query, deps);
	} catch (err) {
		// Outside the guarded paths below — a programming error, not an
		// edge failure. The fire-and-forget registration can't surface
		// it, so it lands here instead of unhandledRejection.
		log.error("mail approval handler failed", err, { query: query.id });
	}
}

async function decide(query: MailApprovalQuery, deps: MailApprovalDeps): Promise<void> {
	const answer = (text?: string) =>
		withTimeout(
			text === undefined
				? deps.api.answerCallbackQuery(query.id)
				: deps.api.answerCallbackQuery(query.id, { text }),
			"answerCallbackQuery",
		).catch((err: unknown) => {
			log.debug("answerCallbackQuery failed", { error: String(err) });
		});

	const match = MAIL_CALLBACK_RE.exec(query.data);
	if (!match) {
		await answer("unknown button");
		return;
	}
	const op = match[1];
	const id = match[2];
	if ((op !== "send" && op !== "cancel") || id === undefined) {
		await answer("unknown button");
		return;
	}
	const outboxId = Number(id);
	const row = deps.outbox.get(outboxId);
	if (row === null) {
		await answer("draft gone");
		return;
	}
	const now = deps.now?.() ?? new Date();

	// Settled rows keep no buttons: a tap racing the decision (or a
	// stale client) strips them and says what already happened.
	if (row.status !== "pending") {
		await stripButtons(deps, row, query);
		await answer(`already ${row.status}`);
		return;
	}
	if (now.getTime() >= new Date(row.expiresAt).getTime()) {
		deps.outbox.decide(outboxId, "expired", now);
		await stampDecision(deps, row, query, `⌛ Draft #${outboxId} expired — never sent.`);
		await answer("draft expired");
		return;
	}

	if (op === "cancel") {
		if (!deps.outbox.decide(outboxId, "cancelled", now)) {
			await answer("already decided");
			return;
		}
		await stampDecision(deps, row, query, `🚫 Draft #${outboxId} cancelled — never sent.`);
		await answer("cancelled");
		return;
	}

	// Send: the slow path — spinner off first, outcomes in the chat.
	if (sending.has(outboxId)) {
		await answer("sending…");
		return;
	}
	sending.add(outboxId);
	try {
		await answer();
		await sendApproved(deps, row, query, now);
	} finally {
		sending.delete(outboxId);
	}
}

async function sendApproved(
	deps: MailApprovalDeps,
	row: OutboxEntry,
	query: MailApprovalQuery,
	now: Date,
): Promise<void> {
	const sender = deps.sender();
	if (sender === null) {
		await notice(deps, row, "⚠️ mail is not configured — the draft stays queued.");
		return;
	}
	// Threading resolves here, at send time — the tool stored only the
	// reply target's id, never touching the send credential.
	let threadId: string | undefined;
	let inReplyTo: string | null | undefined;
	if (row.replyToId !== null) {
		let ctx: { threadId: string; messageId: string | null } | null;
		try {
			ctx = await sender.threadFor(row.replyToId);
		} catch (err) {
			log.error("mail send threading lookup failed", err, { outbox: row.id });
			await notice(deps, row, `⚠️ couldn't reach Gmail to thread the reply (${(err as Error).message}) — tap Send to retry.`);
			return;
		}
		if (ctx === null) {
			await notice(
				deps,
				row,
				"⚠️ the message this answers is gone — tap Cancel and re-queue without a reply, or edit the draft.",
			);
			return;
		}
		threadId = ctx.threadId;
		inReplyTo = ctx.messageId;
	}
	let sent: { id: string; threadId: string };
	try {
		sent = await sender.send({
			to: row.to,
			...(row.cc.length > 0 ? { cc: row.cc } : {}),
			subject: row.subject,
			body: row.body,
			...(threadId !== undefined ? { threadId } : {}),
			...(inReplyTo !== undefined ? { inReplyTo } : {}),
		});
	} catch (err) {
		log.error("mail send failed — draft stays pending for a retry", err, {
			outbox: row.id,
			to: row.to.map(domainOf),
		});
		await notice(deps, row, `⚠️ send failed (${(err as Error).message}) — tap Send to retry.`);
		return;
	}
	// Send-then-decide: a crash between the two leaves a re-tappable
	// pending row (a visible duplicate on retry) rather than a silent
	// loss marked sent.
	if (!deps.outbox.decide(row.id, "sent", now, sent.id)) {
		log.warn("mail sent but the row was already decided — possible duplicate", { outbox: row.id });
	}
	await stampDecision(
		deps,
		row,
		query,
		`✅ Draft #${row.id} sent to ${row.to.join(", ")} — "${row.subject || "(no subject)"}".`,
	);
}

// Rewrite the buttons' message into the verdict. The tapped message is
// the primary target (it IS the buttons); the row's recorded id is the
// fallback for taps that carry no message.
async function stampDecision(
	deps: MailApprovalDeps,
	row: OutboxEntry,
	query: MailApprovalQuery,
	text: string,
): Promise<void> {
	const messageId = query.message?.message_id ?? row.draftMessageId;
	if (messageId === null || messageId === undefined) return;
	await stampMailDraft(
		deps.api,
		{ chatId: row.chatId, threadId: row.threadId },
		messageId,
		text,
	).catch((err: unknown) => {
		log.warn("mail draft stamp failed", { outbox: row.id, error: String(err) });
	});
}

// Rewrite a draft message into its verdict and strip the buttons.
// Throws — callers decide whether a failed stamp retries (the watcher)
// or logs (a tap, whose toast already answered).
export async function stampMailDraft(
	api: Api,
	address: { chatId: number; threadId: number | null },
	messageId: number,
	text: string,
): Promise<void> {
	await withTimeout(
		api.editMessageText(address.chatId, messageId, text, {
			...(address.threadId !== null ? { message_thread_id: address.threadId } : {}),
			reply_markup: { inline_keyboard: [] },
		}),
		"editMessageText",
	);
}

async function stripButtons(
	deps: MailApprovalDeps,
	row: OutboxEntry,
	query: MailApprovalQuery,
): Promise<void> {
	const messageId = query.message?.message_id ?? row.draftMessageId;
	if (messageId === null || messageId === undefined) return;
	await withTimeout(
		deps.api.editMessageReplyMarkup(row.chatId, messageId, {
			...(row.threadId !== null ? { message_thread_id: row.threadId } : {}),
			reply_markup: { inline_keyboard: [] },
		}),
		"editMessageReplyMarkup",
	).catch((err: unknown) => {
		log.debug("mail button strip failed", { outbox: row.id, error: String(err) });
	});
}

// A send-path failure lands in the chat, where the operator is watching
// for a verdict that never came. Delivery failures log-and-continue —
// the row is still pending, so nothing is lost.
async function notice(deps: MailApprovalDeps, row: OutboxEntry, text: string): Promise<void> {
	await sendMailNotice(deps.api, { chatId: row.chatId, threadId: row.threadId }, text).catch(
		(err: unknown) => {
			log.warn("mail notice failed", { outbox: row.id, error: String(err) });
		},
	);
}

// Plain-text delivery into a mail conversation — outage notices and
// send failures. Throws: the watcher retries next tick, a tap's notice
// logs instead (its toast already answered).
export async function sendMailNotice(
	api: Api,
	address: { chatId: number; threadId: number | null },
	text: string,
): Promise<void> {
	await withTimeout(
		api.sendMessage(address.chatId, text, {
			...(address.threadId !== null ? { message_thread_id: address.threadId } : {}),
		}),
		"sendMessage",
	);
}
