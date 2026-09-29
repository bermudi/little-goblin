// The mail approval gate — the draft's one owner (DESIGN.md, "Email"):
// a request from the mail tool is issued here (queue the outbox row,
// post the draft with Send/Cancel buttons, bind the buttons' message
// id), the taps decide here — send/cancel/expired/gone, double-tap,
// missing original — through the send credential, which no tool path
// ever holds, and the expiry sweep runs here on its own ticker. The
// mail watcher only polls filters. A factory, so the decision paths
// are testable without a live bot and the in-flight send set stays
// private closure state.

import type { Api } from "grammy";
import type { MailPoller, MailSender } from "../mail.ts";
import { domainOf } from "../mail.ts";
import type { OutboxEntry, OutboxStore } from "../mail-outbox.ts";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";

export const MAIL_SEND_PREFIX = "mail:send:";
export const MAIL_CANCEL_PREFIX = "mail:cancel:";
export const MAIL_CALLBACK_RE = /^mail:(send|cancel):(\d+)$/;

// Telegram caps a message at 4096 chars — drafts chunk below it, and
// past four chunks the draft truncates with an explicit marker rather
// than flooding the chat.
const DRAFT_CHUNK = 3800;
const MAX_DRAFT_CHUNKS = 4;

const SWEEP_TICK_MS = 5 * 60_000;

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
	/** Live gws poll client, or null when mail is unconfigured — the
	 *  threading lookup is a read through gws's own auth, never the
	 *  send token (which only ever sends). */
	reader(): MailPoller | null;
	/** Test door for expiry. */
	now?(): Date;
}

export interface MailApproval {
	/** The mail tool's whole send path: queue the row, post the draft
	 *  with its buttons into the pinned conversation, bind the buttons'
	 *  message id. A definite Telegram post failure cancels the row
	 *  and resolves a retryable error; a timeout leaves it pending
	 *  because the buttons may have landed without an id to bind. */
	requestDraft(
		input: { to: string[]; cc?: string[]; subject: string; body: string; replyToId?: string },
		address: { chatId: number; threadId: number | null },
	): Promise<{ queued: number; status: string } | { error: string }>;

	/** One Send/Cancel tap decision. */
	handleTap(query: MailApprovalQuery): Promise<void>;

	/** One expiry sweep now — the timer's body and the test door. */
	sweep(): Promise<void>;

	stop(): void;
}

export function startMailApproval(deps: MailApprovalDeps, tickMs = SWEEP_TICK_MS): MailApproval {
	// One in-flight send per draft: the Gmail call is slow, and a second
	// tap inside it would otherwise double-send. The set also fences the
	// other deciders — a Cancel tap from a second device, the tap-time
	// expiry branch, and the expiry sweep must not stamp a row whose
	// mail is already leaving; the send's own verdict wins. (A restart
	// clears the set; a pending row stays re-tappable — the crash
	// window is one tap.)
	const sending = new Set<number>();

	const requestDraft = async (
		input: { to: string[]; cc?: string[]; subject: string; body: string; replyToId?: string },
		address: { chatId: number; threadId: number | null },
	): Promise<{ queued: number; status: string } | { error: string }> => {
		const row = deps.outbox.queue({ ...input, address });
		// Definite post failures cancel the row; a sendMessage timeout
		// does not prove delivery failed, even if no message id was returned.
		let messageId: number;
		try {
			messageId = await postMailDraft(deps.api, address, row.id, draftText(row.id, input, row.expiresAt));
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				return {
					queued: row.id,
					status: `draft #${row.id} delivery to Telegram is uncertain — no automatic cancellation or retry; check Telegram before retrying (buttons may already be visible)`,
				};
			}
			deps.outbox.decide(row.id, "cancelled", new Date());
			log.error("mail draft posting failed — draft cancelled", err, {
				outbox: row.id, chat: address.chatId, thread: address.threadId,
			});
			return {
				error:
					"posting the draft to Telegram failed — the draft was cancelled; retry the send when delivery recovers",
			};
		}
		deps.outbox.bindDraft(row.id, messageId);
		return {
			queued: row.id,
			status: "awaiting operator approval — the draft is in Telegram with Send/Cancel buttons",
		};
	};

	const handleTap = async (query: MailApprovalQuery): Promise<void> => {
		try {
			await decide(query);
		} catch (err) {
			// Outside the guarded paths below — a programming error, not an
			// edge failure. The fire-and-forget registration can't surface
			// it, so it lands here instead of unhandledRejection.
			log.error("mail approval handler failed", err, { query: query.id });
		}
	};

	const decide = async (query: MailApprovalQuery): Promise<void> => {
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
		// A send is in flight: its own verdict is coming. A Cancel tap from
		// a second device or a stale client, and the expiry branch below,
		// must not decide a row whose mail is already leaving — "never
		// sent" would be a lie stamped over a send in progress.
		if (sending.has(outboxId)) {
			await answer("sending — wait for the verdict");
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
		sending.add(outboxId);
		try {
			await answer();
			await sendApproved(deps, row, query, now);
		} finally {
			sending.delete(outboxId);
		}
	};

	const sweep = (): Promise<void> => sweepExpired(deps, sending);

	const timer = setInterval(() => {
		void sweep();
	}, tickMs);
	void sweep(); // boot catch-up: rows that expired while down settle now

	return { requestDraft, handleTap, sweep, stop: () => clearInterval(timer) };
}

// Render the draft the operator approves — the tool's send input, plus
// the queued row's id and fuse.
function draftText(
	id: number,
	input: { to: string[]; cc?: string[]; subject: string; body: string; replyToId?: string },
	expiresAt: string,
): string {
	return [
		`✉️ Draft #${id} — tap Send to send, Cancel to discard (expires ${expiresAt}).`,
		`To: ${input.to.join(", ")}`,
		...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
		`Subject: ${input.subject || "(no subject)"}`,
		...(input.replyToId ? [`Reply to: ${input.replyToId}`] : []),
		"",
		input.body,
	].join("\n");
}

// Post the draft, chunked, with Send/Cancel on the last message.
// Resolves the buttons' message id for the outbox row.
async function postMailDraft(
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
		try {
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
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				log.warn("mail draft posting timed out — delivery uncertain; no automatic cancellation", {
					outbox: outboxId, chat: address.chatId, thread: address.threadId,
					chunk: i + 1, chunks: chunks.length, buttons: last, error: String(err),
				});
			}
			throw err;
		}
	}
	log.info("mail draft posted", {
		outbox: outboxId,
		conversation: address.threadId === null ? `dm:${address.chatId}` : `topic:${address.chatId}:${address.threadId}`,
		message: messageId,
		chunks: chunks.length,
	});
	return messageId;
}

export function chunkDraft(text: string): string[] {
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
		// Don't split a UTF-16 surrogate pair at the hard boundary.
		const before = rest.charCodeAt(cut - 1);
		const after = rest.charCodeAt(cut);
		if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut--;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) {
		chunks[chunks.length - 1] += `\n\n[… draft truncated for Telegram — ${text.length} chars total]`;
	}
	return chunks;
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
	// reply target's id. The lookup itself is a gws metadata read under
	// gws's own auth, which still never sends — the send credential
	// stays the only sender in this path.
	let threadId: string | undefined;
	let inReplyTo: string | null | undefined;
	if (row.replyToId !== null) {
		const reader = deps.reader();
		if (reader === null) {
			await notice(
				deps,
				row,
				"⚠️ mail reading is not configured — couldn't thread the reply — tap Send to retry.",
			);
			return;
		}
		let ctx: { threadId: string; messageId: string | null } | null;
		try {
			ctx = await reader.threadFor(row.replyToId);
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
// Throws — callers decide whether a failed stamp retries (the sweep)
// or logs (a tap, whose toast already answered).
async function stampMailDraft(
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

// Plain-text delivery into a mail conversation — outage notices (the
// watcher) and send failures. Throws: the watcher retries next tick, a
// tap's notice logs instead (its toast already answered).
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

// Expired drafts settle here when no tap beats the fuse. Stamping is
// best-effort per row — a Telegram failure must not stop the sweep,
// and the row is already expired, so a stale tap answers "already
// expired" and strips its own buttons.
async function sweepExpired(deps: MailApprovalDeps, sending: Set<number>): Promise<void> {
	const now = deps.now?.() ?? new Date();
	let rows: ReturnType<OutboxStore["expireDue"]>;
	try {
		// Rows mid-send are excluded at the store: their Gmail send is
		// deciding them, and an "expired — never sent" stamp over a send
		// in flight would be a lie.
		rows = deps.outbox.expireDue(now, (id) => sending.has(id));
	} catch (err) {
		log.error("outbox expiry sweep failed", err);
		return;
	}
	await Promise.allSettled(
		rows
			.filter((row) => row.draftMessageId !== null)
			.map((row) =>
				stampMailDraft(
					deps.api,
					{ chatId: row.chatId, threadId: row.threadId },
					row.draftMessageId!,
					`⌛ Draft #${row.id} expired — never sent.`,
				).catch((err: unknown) => {
					log.warn("expired draft stamp failed", { outbox: row.id, error: String(err) });
				}),
			),
	);
	if (rows.length > 0) {
		log.info("outbox expiry swept", { count: rows.length });
	}
}
