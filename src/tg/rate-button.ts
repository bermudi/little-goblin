// The 👍/👎 buttons on a completed reply: one tap → one durable row.
// Extracted like speak-button so the tap boundaries — answer once,
// surface a store failure honestly — are testable without a live bot.

import type { Api, Bot } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";
import type { ReplyRating, ReplyRatings } from "./ratings.ts";

// callback_data: rate:<vote>|<conversation>|<anchor>. The payload is
// self-describing — no binding table — so a tap on a pre-restart reply
// still records, and a rolled DM's older bubbles keep their own
// exchange. `x` marks a landed reply that had no user anchor.
// The routing claim is the bare prefix — a payload from a drifted
// version still routes here and gets an honest "stale" answer instead
// of a spinning button.
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

// Structural subset of Telegram's CallbackQuery — the fields this flow
// reads (the speak-button pattern: grammy's full type is assignable).
// reply_markup rides along so the tap can retire its own row without
// touching siblings like 🔊.
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
	// Awaited, not detached: the whole job is one store write plus the
	// toast, so grammy serializes taps and a failure lands in bot.catch's
	// neighbourhood instead of a floating promise.
	bot.callbackQuery(RATE_CALLBACK_RE, (ctx) => handleRateButton(ctx.callbackQuery, deps));
}

export async function handleRateButton(query: RateQuery, deps: RateButtonDeps): Promise<void> {
	try {
		await rate(query, deps);
	} catch (err) {
		// Outside the guarded boundaries below — a programming error, not
		// an edge failure. Registration can't surface it, so it lands here.
		log.error("rate button handler failed", err, { query: query.id });
	}
}

// A tap retires the rating row (design/telegram.md — "Buttons and small
// parts"): when it shared the keyboard (the 🔊 row), the row collapses
// into a disabled button recording the vote — layout persists; when it
// was the whole markup, the strip leaves nothing. Cosmetic — the rating
// is already durable, so a failed strip just keeps its buttons.
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
	// The tap is answered exactly once; the answer rides the recorded
	// outcome, so it waits for the (synchronous, fast) store write.
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
	// The toast shouldn't wait behind the strip — an API stall there
	// would hold the ack for the full call timeout.
	await Promise.all([
		stripRatingRow(deps.api, message, parsed.rating),
		answer(parsed.rating === "up" ? "👍 recorded" : "👎 recorded"),
	]);
}
