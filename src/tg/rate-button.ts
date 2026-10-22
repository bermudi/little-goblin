import type { Api, Bot } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";
import type { ReplyRating, ReplyRatings } from "../reply-ratings.ts";

export const RATE_CALLBACK_RE = /^rate:/;
const RATE_DATA_RE = /^rate:(up|down)\|([^|]+)\|(\d+|x)$/;

export function rateCallbackData(
	vote: ReplyRating,
	conversationId: string,
	anchorSeq: number | null,
): string {
	return `rate:${vote}|${conversationId}|${anchorSeq ?? "x"}`;
}

function parseRateCallback(data: string): {
	rating: ReplyRating;
	conversationId: string;
	anchorSeq: number | null;
} | null {
	const m = RATE_DATA_RE.exec(data);
	if (m === null) return null;
	const rating: ReplyRating = m[1] === "up" ? "up" : "down";
	return {
		rating,
		conversationId: m[2]!,
		anchorSeq: m[3] === "x" ? null : Number(m[3]),
	};
}

export interface RateQuery {
	id: string;
	data?: string | undefined;
	message?: {
		message_id: number;
		chat: { id: number };
		message_thread_id?: number;
		reply_markup?: InlineKeyboardMarkup;
	};
}

export interface RateButtonDeps {
	api: Api;
	ratings: ReplyRatings;
}

export function registerRateButton(bot: Bot, deps: RateButtonDeps): void {
	bot.callbackQuery(RATE_CALLBACK_RE, (ctx) => handleRateButton(ctx.callbackQuery, deps));
}

export async function handleRateButton(query: RateQuery, deps: RateButtonDeps): Promise<void> {
	try {
		await rate(query, deps);
	} catch (err) {
		log.error("rate button handler failed", err, { query: query.id });
		await withTimeout(
			deps.api.answerCallbackQuery(query.id, { text: "internal error" }),
			"answerCallbackQuery",
		).catch((e: unknown) => log.debug("answerCallbackQuery failed", { error: String(e) }));
	}
}

async function stripRatingRow(
	api: Api,
	message: NonNullable<RateQuery["message"]>,
	rating: ReplyRating,
): Promise<void> {
	const rows = message.reply_markup?.inline_keyboard;
	if (rows === undefined) return;
	const isRate = (b: InlineKeyboardButton) =>
		"callback_data" in b && RATE_CALLBACK_RE.test(b.callback_data);
	if (!rows.some((row) => row.some(isRate))) return;
	const rest = rows.filter((row) => !row.some(isRate));
	const inline_keyboard =
		rest.length === 0 ? [] : [[{ text: rating === "up" ? "👍" : "👎", disabled: {} }], ...rest];
	await withTimeout(
		api.editMessageReplyMarkup(message.chat.id, message.message_id, {
			...(message.message_thread_id !== undefined
				? { message_thread_id: message.message_thread_id }
				: {}),
			reply_markup: { inline_keyboard },
		}),
		"editMessageReplyMarkup",
	).catch((err: unknown) => {
		log.debug("rate strip failed", { error: String(err) });
	});
}

async function rate(query: RateQuery, deps: RateButtonDeps): Promise<void> {
	const answer = (text: string) =>
		withTimeout(deps.api.answerCallbackQuery(query.id, { text }), "answerCallbackQuery").catch(
			(err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			},
		);

	const parsed = query.data === undefined ? null : parseRateCallback(query.data);
	if (parsed === null) {
		await answer("that button is stale");
		return;
	}
	const message = query.message;
	if (message === undefined) {
		await answer("nothing to rate here");
		return;
	}
	try {
		deps.ratings.record({
			conversationId: parsed.conversationId,
			anchorSeq: parsed.anchorSeq,
			chatId: message.chat.id,
			messageId: message.message_id,
			rating: parsed.rating,
		});
	} catch (err) {
		log.error("reply rating write failed", err, {
			conversation: parsed.conversationId,
			chat: message.chat.id,
			message: message.message_id,
		});
		await answer("rating not recorded — check the log");
		return;
	}
	log.info("reply rated", {
		conversation: parsed.conversationId,
		anchor: parsed.anchorSeq,
		chat: message.chat.id,
		message: message.message_id,
		rating: parsed.rating,
	});
	await Promise.all([
		stripRatingRow(deps.api, message, parsed.rating),
		answer(parsed.rating === "up" ? "👍 recorded" : "👎 recorded"),
	]);
}
