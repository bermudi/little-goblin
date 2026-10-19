import type { Api } from "grammy";
import { formatAddress } from "../conversation.ts";
import type { MailPoller, MailSender } from "../mail.ts";
import { domainOf } from "../mail.ts";
import type { OutboxEntry, OutboxStore } from "../mail-outbox.ts";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";

export const MAIL_SEND_PREFIX = "mail:send:";
export const MAIL_CANCEL_PREFIX = "mail:cancel:";
export const MAIL_CALLBACK_RE = /^mail:(send|cancel):(\d+)$/;

const DRAFT_CHUNK = 3800;
const MAX_DRAFT_CHUNKS = 4;

const SWEEP_TICK_MS = 5 * 60_000;

export class MailDraftTimeoutError extends TelegramTimeoutError {
	constructor(
		err: TelegramTimeoutError,
		readonly buttonsAttempted: boolean,
	) {
		super(err.label, err.ms);
		this.name = "MailDraftTimeoutError";
		this.cause = err;
	}
}

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
	sender(): MailSender | null;
	reader(): MailPoller | null;
	now?(): Date;
}

export interface MailApproval {
	requestDraft(
		input: { to: string[]; cc?: string[]; subject: string; body: string; replyToId?: string },
		address: { chatId: number; threadId: number | null },
	): Promise<{ queued: number; status: string } | { error: string }>;

	handleTap(query: MailApprovalQuery): Promise<void>;

	sweep(): Promise<void>;

	stop(): Promise<void>;
}

export function startMailApproval(deps: MailApprovalDeps, tickMs = SWEEP_TICK_MS): MailApproval {
	const inFlight = new Map<number, Promise<void>>();

	const requestDraft = async (
		input: { to: string[]; cc?: string[]; subject: string; body: string; replyToId?: string },
		address: { chatId: number; threadId: number | null },
	): Promise<{ queued: number; status: string } | { error: string }> => {
		const row = deps.outbox.queue({ ...input, address });
		let messageId: number;
		try {
			messageId = await postMailDraft(
				deps.api,
				address,
				row.id,
				draftText(row.id, input, row.expiresAt),
			);
		} catch (err) {
			if (err instanceof MailDraftTimeoutError && !err.buttonsAttempted) {
				deps.outbox.decide(row.id, "cancelled", new Date());
				log.warn("mail draft timed out before its buttons — draft cancelled", {
					outbox: row.id,
					chat: address.chatId,
					thread: address.threadId,
				});
				return {
					error: `draft #${row.id} timed out posting to Telegram before its approval buttons — the draft was cancelled (delivered chunks may be visible); retry the send when delivery recovers`,
				};
			}
			if (err instanceof TelegramTimeoutError) {
				return {
					queued: row.id,
					status: `draft #${row.id} delivery to Telegram is uncertain — no automatic cancellation or retry; check Telegram before retrying (buttons may already be visible)`,
				};
			}
			deps.outbox.decide(row.id, "cancelled", new Date());
			log.error("mail draft posting failed — draft cancelled", err, {
				outbox: row.id,
				chat: address.chatId,
				thread: address.threadId,
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
			log.error("mail approval handler failed", err, { query: query.id });
			await withTimeout(
				deps.api.answerCallbackQuery(query.id, { text: "internal error" }),
				"answerCallbackQuery",
			).catch((e: unknown) => log.debug("answerCallbackQuery failed", { error: String(e) }));
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

		if (row.status !== "pending") {
			await stripButtons(deps, row, query);
			await answer(`already ${row.status}`);
			return;
		}
		if (inFlight.has(outboxId)) {
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

		const send = (async () => {
			try {
				await answer();
				await sendApproved(deps, row, query, now);
			} finally {
				inFlight.delete(outboxId);
			}
		})();
		inFlight.set(outboxId, send);
		await send;
	};

	const sweep = (): Promise<void> => sweepExpired(deps, inFlight);

	const timer = setInterval(() => {
		void sweep();
	}, tickMs);
	void sweep();

	return {
		requestDraft,
		handleTap,
		sweep,
		stop: async () => {
			clearInterval(timer);
			const waits = [...inFlight.values()];
			if (waits.length > 0) {
				log.info("mail approval — joining in-flight send on shutdown", {
					sends: waits.length,
				});
			}
			await Promise.allSettled(waits);
		},
	};
}

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
									inline_keyboard: [
										[
											{ text: "✅ Send", callback_data: `${MAIL_SEND_PREFIX}${outboxId}` },
											{ text: "🚫 Cancel", callback_data: `${MAIL_CANCEL_PREFIX}${outboxId}` },
										],
									],
								},
							}
						: {}),
				}),
				"sendMessage",
			);
			messageId = sent.message_id;
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				log.warn("mail draft posting timed out — delivery uncertain", err, {
					outbox: outboxId,
					chat: address.chatId,
					thread: address.threadId,
					chunk: i + 1,
					chunks: chunks.length,
					buttons: last,
				});
				throw new MailDraftTimeoutError(err, last);
			}
			throw err;
		}
	}
	log.info("mail draft posted", {
		outbox: outboxId,
		conversation: formatAddress(
			address.threadId === null
				? { kind: "dm", chatId: address.chatId }
				: { kind: "topic", chatId: address.chatId, threadId: address.threadId },
		),
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
		const before = rest.charCodeAt(cut - 1);
		const after = rest.charCodeAt(cut);
		if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut--;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) {
		chunks[chunks.length - 1] +=
			`\n\n[… draft truncated for Telegram — ${text.length} chars total]`;
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
			await notice(
				deps,
				row,
				`⚠️ couldn't reach Gmail to thread the reply (${(err as Error).message}) — tap Send to retry.`,
			);
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
		log.warn("mail draft stamp failed", err, { outbox: row.id });
	});
}

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

async function notice(deps: MailApprovalDeps, row: OutboxEntry, text: string): Promise<void> {
	await sendMailNotice(deps.api, { chatId: row.chatId, threadId: row.threadId }, text).catch(
		(err: unknown) => {
			log.warn("mail notice failed", err, { outbox: row.id });
		},
	);
}

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

async function sweepExpired(
	deps: MailApprovalDeps,
	sending: { has(id: number): boolean },
): Promise<void> {
	const now = deps.now?.() ?? new Date();
	let rows: ReturnType<OutboxStore["expireDue"]>;
	try {
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
					log.warn("expired draft stamp failed", err, { outbox: row.id });
				}),
			),
	);
	if (rows.length > 0) {
		log.info("outbox expiry swept", { count: rows.length });
	}
}
