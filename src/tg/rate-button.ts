import type { Api, Bot } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import type { ReplyRating, ReplyRatings } from "../reply-ratings.ts";

export const RATE_CALLBACK_RE = /^rate:/;
// Callback queries expire quickly; don't wait for the normal 30s API deadline.
const RATE_EDIT_WAIT_MS = 1_000;
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
	/** Deadline for waiting on an edit, including its place in the queue. */
	editTimeoutMs?: number;
}

export function registerRateButton(bot: Bot, deps: RateButtonDeps): void {
	bot.callbackQuery(RATE_CALLBACK_RE, (ctx) => handleRateButton(ctx.callbackQuery, deps));
}

export async function handleRateButton(query: RateQuery, deps: RateButtonDeps): Promise<void> {
	try {
		await rate(query, deps);
	} catch (err) {
		// In particular, do not attempt a second answer after an uncertain
		// answerCallbackQuery failure: the first answer may have landed.
		throw new Error(`rate button handler failed for query ${query.id}`, { cause: err });
	}
}

// Records are written synchronously in callback arrival order. Serialize
// edits in that same order, including stale snapshots, so the final visible
// vote matches the latest stored vote. A failed edit must not poison the queue.
const stripChains = new Map<string, Promise<void>>();

function stripRatingRow(
	api: Api,
	message: NonNullable<RateQuery["message"]>,
	rating: ReplyRating,
	timeoutMs?: number,
): Promise<void> {
	const key = `${message.chat.id}:${message.message_id}`;
	const prev = stripChains.get(key) ?? Promise.resolve();
	const edit = () => doStripRatingRow(api, message, rating);
	const run = prev.then(edit, edit);
	stripChains.set(key, run);
	const clear = () => {
		if (stripChains.get(key) === run) stripChains.delete(key);
	};
	void run.then(clear, clear);
	// Bound the handler, not the queue: a timed-out request can still land.
	// Keep its successor behind the actual request until it settles.
	return withTimeout(run, "editMessageReplyMarkup (rate queue)", timeoutMs ?? RATE_EDIT_WAIT_MS);
}

async function doStripRatingRow(
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
	try {
		await api.editMessageReplyMarkup(message.chat.id, message.message_id, {
			...(message.message_thread_id !== undefined
				? { message_thread_id: message.message_thread_id }
				: {}),
			reply_markup: { inline_keyboard },
		});
		log.info("rate strip applied", { chat: message.chat.id, message: message.message_id, rating });
	} catch (err) {
		// This also records a late failure after the callback wait timed out.
		log.error("rate strip failed", err, { chat: message.chat.id, message: message.message_id });
		throw new Error(`rate strip failed for chat ${message.chat.id} message ${message.message_id}`, {
			cause: err,
		});
	}
}

async function rate(query: RateQuery, deps: RateButtonDeps): Promise<void> {
	const answer = (text: string) =>
		withTimeout(deps.api.answerCallbackQuery(query.id, { text }), "answerCallbackQuery");

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
	let text = parsed.rating === "up" ? "👍 recorded" : "👎 recorded";
	try {
		await stripRatingRow(deps.api, message, parsed.rating, deps.editTimeoutMs);
	} catch (err) {
		log.error("rate strip wait failed", err, {
			chat: message.chat.id,
			message: message.message_id,
		});
		text =
			err instanceof TelegramTimeoutError
				? "rating recorded — display may be stale"
				: "rating recorded — display update failed";
	}
	await answer(text);
}
