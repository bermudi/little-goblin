// Telegram presentation for mail approvals: chunked draft posting,
// Send/Cancel buttons, callback translation/answers, notices and draft
// stamps. Queueing, expiry, in-flight exclusion, Gmail send and the
// outbox CAS live in ../mail-approval.ts.

import type { Api } from "grammy";
import { formatAddress } from "../conversation.ts";
import {
	type MailApproval,
	type MailApprovalLane,
	type MailDecision,
	type MailDraftAddress,
	type MailDraftInput,
	type MailPresentationResult,
} from "../mail-approval.ts";
import type { OutboxEntry } from "../mail-outbox.ts";
import { log } from "../log.ts";
import { telegramActor, telegramAddressOf } from "../targets.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";

export const MAIL_SEND_PREFIX = "mail:send:";
export const MAIL_CANCEL_PREFIX = "mail:cancel:";
export const MAIL_CALLBACK_RE = /^mail:(send|cancel):(\d+)$/;

const DRAFT_CHUNK = 3800;
const MAX_DRAFT_CHUNKS = 4;

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
	from: { id: number };
	message?: {
		message_id: number;
		chat: { id: number };
	};
}

export interface TelegramMailApproval {
	requestDraft(
		input: MailDraftInput,
		address: MailDraftAddress,
	): Promise<{ queued: number; status: string } | { error: string }>;
	handleTap(query: MailApprovalQuery): Promise<void>;
	sweep(): Promise<void>;
	stop(): Promise<void>;
}

export function startTelegramMailApproval(
	deps: { api: Api; approval: MailApproval },
): TelegramMailApproval {
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
		const action = match[1] === "send" ? "send" : "cancel";
		const outboxId = Number(match[2]);
		const outcome: MailDecision = await deps.approval.decide(
			outboxId,
			action,
			telegramActor(query.from.id),
			{ ...(query.message?.message_id !== undefined ? { messageId: query.message.message_id } : {}) },
		);
		if (outcome.kind === "sent") {
			await answer();
			return;
		}
		await answer(answerText(outcome));
	};

	return {
		requestDraft: (input, address) => deps.approval.requestDraft(input, address),
		handleTap,
		sweep: () => deps.approval.sweep(),
		stop: () => deps.approval.stop(),
	};
}

function answerText(outcome: MailDecision): string {
	switch (outcome.kind) {
		case "gone":
			return "draft gone";
		case "settled":
			return `already ${outcome.row.status}`;
		case "busy":
			return "sending — wait for the verdict";
		case "expired":
			return "draft expired";
		case "cancelled":
			return "cancelled";
		case "sent":
			return "sent";
		case "retry":
			return "send failed — see the notice";
		case "conflict":
			return "send raced another decision";
	}
}

export function makeTelegramMailLane(api: Api): MailApprovalLane {
	return {
		async present(row) {
			const address = telegramAddressOf(row.target);
			if (address === null) throw new Error(`draft ${row.id} is not addressed to Telegram`);
			try {
				const messageId = await postMailDraft(api, address, row.id, draftText(row));
				return { kind: "posted", messageId, surface: "Telegram" } satisfies MailPresentationResult;
			} catch (err) {
				if (err instanceof MailDraftTimeoutError && !err.buttonsAttempted) {
					return {
						kind: "failed",
						detail: "timed out before its approval buttons",
					};
				}
				if (err instanceof TelegramTimeoutError) {
					return {
						kind: "uncertain",
						detail: `Telegram delivery timed out${err instanceof MailDraftTimeoutError && err.buttonsAttempted ? " after the buttons chunk began" : ""}`,
					};
				}
				throw err;
			}
		},
		async notice(row, text) {
			const address = telegramAddressOf(row.target);
			if (address === null) return;
			await sendMailNotice(api, address, text).catch((err: unknown) => {
				log.warn("mail notice failed", err, { outbox: row.id });
			});
		},
		async settle(row, text, opts) {
			const address = telegramAddressOf(row.target);
			const messageId = opts?.messageId ?? row.draftMessageId;
			if (address === null || messageId === null || messageId === undefined) return;
			await stampMailDraft(api, address, messageId, text).catch((err: unknown) => {
				log.warn("mail draft stamp failed", err, { outbox: row.id });
			});
		},
		async strip(row, opts) {
			const address = telegramAddressOf(row.target);
			const messageId = opts?.messageId ?? row.draftMessageId;
			if (address === null || messageId === null || messageId === undefined) return;
			await withTimeout(
				api.editMessageReplyMarkup(address.chatId, messageId, {
					...(address.threadId !== null ? { message_thread_id: address.threadId } : {}),
					reply_markup: { inline_keyboard: [] },
				}),
				"editMessageReplyMarkup",
			).catch((err: unknown) => {
				log.debug("mail button strip failed", { outbox: row.id, error: String(err) });
			});
		},
	};
}

export function draftText(row: OutboxEntry): string {
	return [
		`✉️ Draft #${row.id} — tap Send to send, Cancel to discard (expires ${row.expiresAt}).`,
		`To: ${row.to.join(", ")}`,
		...(row.cc.length ? [`Cc: ${row.cc.join(", ")}`] : []),
		`Subject: ${row.subject || "(no subject)"}`,
		...(row.replyToId !== null ? [`Reply to: ${row.replyToId}`] : []),
		"",
		row.body,
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
