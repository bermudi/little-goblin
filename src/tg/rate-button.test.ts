// The 👍/👎 tap's boundaries: the payload round-trips, the row lands
// before the toast answers, edge taps get an honest answer — plus the
// grammy routing the registration installs.

import { describe, expect, test } from "bun:test";
import { Bot, type Api } from "grammy";
import { fakeApi, type RecordedCall } from "../testkit/fake-api.ts";
import type { Update } from "grammy/types";
import {
	handleRateButton,
	rateCallbackData,
	registerRateButton,
	type RateQuery,
} from "./rate-button.ts";
import type { ReplyRatings, ReplyRatingWrite } from "../reply-ratings.ts";

function answers(calls: RecordedCall[]): (string | undefined)[] {
	return calls
		.filter((c) => c.method === "answerCallbackQuery")
		.map((c) => (c.args[1] as { text?: string } | undefined)?.text);
}

function fakeRatings(fail = false): ReplyRatings & { records: ReplyRatingWrite[] } {
	const records: ReplyRatingWrite[] = [];
	return {
		records,
		record(entry) {
			if (fail) throw new Error("db closed");
			records.push(entry);
		},
		latest: () => null,
		recordApp: () => {},
		latestEvent: () => null,
		listApp: () => [],
	};
}

function query(
	data: string | undefined,
	chatId = 1,
	messageId = 10,
	markup?: NonNullable<NonNullable<RateQuery["message"]>["reply_markup"]>,
): RateQuery {
	return {
		id: `q-${messageId}`,
		data,
		message: {
			message_id: messageId,
			chat: { id: chatId },
			...(markup !== undefined ? { reply_markup: markup } : {}),
		},
	};
}

function markups(calls: RecordedCall[]): Array<Array<Array<Record<string, unknown>>>> {
	return calls
		.filter((c) => c.method === "editMessageReplyMarkup")
		.map(
			(c) =>
				(c.args[2] as { reply_markup: { inline_keyboard: Array<Array<Record<string, unknown>>> } })
					.reply_markup.inline_keyboard,
		);
}

describe("rate button", () => {
	test("a tap records the row with the payload's target, then toasts", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		await handleRateButton(query(rateCallbackData("up", "dm:1:3", 7), 42, 10), {
			api: fake.api,
			ratings,
		});
		expect(ratings.records).toEqual([
			{
				conversationId: "dm:1:3",
				anchorSeq: 7,
				chatId: 42,
				messageId: 10,
				rating: "up",
			},
		]);
		expect(answers(fake.calls)).toEqual(["👍 recorded"]);
	});

	test("a landed reply with no user anchor records a null anchor", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		await handleRateButton(query(rateCallbackData("down", "topic:-100:9", null)), {
			api: fake.api,
			ratings,
		});
		expect(ratings.records[0]).toMatchObject({ anchorSeq: null, rating: "down" });
		expect(answers(fake.calls)).toEqual(["👎 recorded"]);
	});

	test("a malformed payload is answered stale, nothing recorded", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		await handleRateButton(query("rate:sideways|dm:1|7"), { api: fake.api, ratings });
		await handleRateButton(query(undefined), { api: fake.api, ratings });
		expect(ratings.records).toEqual([]);
		expect(answers(fake.calls)).toEqual(["that button is stale", "that button is stale"]);
	});

	test("a query without a message can't record", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		await handleRateButton(
			{ id: "q1", data: rateCallbackData("up", "dm:1", 1) },
			{ api: fake.api, ratings },
		);
		expect(ratings.records).toEqual([]);
		expect(answers(fake.calls)).toEqual(["nothing to rate here"]);
	});

	test("a store failure still answers — the toast carries the outcome", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings(true);
		await handleRateButton(query(rateCallbackData("up", "dm:1", 1)), {
			api: fake.api,
			ratings,
		});
		expect(answers(fake.calls)).toEqual(["rating not recorded — check the log"]);
	});

	test("a tap retires the rating row — the vote stays visible, 🔊 stays live", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		const markup = {
			inline_keyboard: [
				[
					{ text: "👍", callback_data: rateCallbackData("up", "dm:1", 7) },
					{ text: "👎", callback_data: rateCallbackData("down", "dm:1", 7) },
				],
				[{ text: "🔊", callback_data: "speak_reply" }],
			],
		};
		await handleRateButton(query(rateCallbackData("up", "dm:1", 7), 42, 10, markup), {
			api: fake.api,
			ratings,
		});
		expect(markups(fake.calls)).toEqual([
			[[{ text: "👍", disabled: {} }], [{ text: "🔊", callback_data: "speak_reply" }]],
		]);
		expect(answers(fake.calls)).toEqual(["👍 recorded"]);
		expect(fake.calls.map((call) => call.method)).toEqual([
			"editMessageReplyMarkup",
			"answerCallbackQuery",
		]);
	});

	test("a rating-only keyboard strips to empty", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		const markup = {
			inline_keyboard: [
				[
					{ text: "👍", callback_data: rateCallbackData("up", "dm:1", 7) },
					{ text: "👎", callback_data: rateCallbackData("down", "dm:1", 7) },
				],
			],
		};
		await handleRateButton(query(rateCallbackData("down", "dm:1", 7), 42, 10, markup), {
			api: fake.api,
			ratings,
		});
		expect(markups(fake.calls)).toEqual([[]]);
	});

	test("no rate row or no markup at all — no edit call, still recorded", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		const speakOnly = { inline_keyboard: [[{ text: "🔊", callback_data: "speak_reply" }]] };
		await handleRateButton(query(rateCallbackData("up", "dm:1", 7), 42, 10, speakOnly), {
			api: fake.api,
			ratings,
		});
		await handleRateButton(query(rateCallbackData("up", "dm:1", 7)), {
			api: fake.api,
			ratings,
		});
		expect(markups(fake.calls)).toEqual([]);
		expect(ratings.records).toHaveLength(2);
	});

	test("an edit failure reports the saved vote and does not poison later edits", async () => {
		let edits = 0;
		const fake = fakeApi({
			failOn: (method) => method === "editMessageReplyMarkup" && ++edits === 1,
		});
		const ratings = fakeRatings();
		const markup = { inline_keyboard: [[{ text: "👍", callback_data: "rate:up|dm:1|7" }]] };
		const deps = { api: fake.api, ratings };
		await handleRateButton(query("rate:up|dm:1|7", 42, 76, markup), deps);
		await handleRateButton(query("rate:down|dm:1|7", 42, 76, markup), deps);
		expect(ratings.records.map((r) => r.rating)).toEqual(["up", "down"]);
		expect(edits).toBe(2);
		expect(answers(fake.calls)).toEqual(["rating recorded — display update failed", "👎 recorded"]);
	});

	test("a callback answer failure propagates without attempting a second answer", async () => {
		const fake = fakeApi({ failOn: (method) => method === "answerCallbackQuery" });
		const ratings = fakeRatings();
		await expect(
			handleRateButton(query("rate:up|dm:1|7"), { api: fake.api, ratings }),
		).rejects.toThrow("rate button handler failed for query q-10");
		expect(ratings.records).toHaveLength(1);
		expect(answers(fake.calls)).toEqual(["👍 recorded"]);
	});

	test("concurrent opposite taps display the latest stored vote", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let edits = 0;
		const fake = fakeApi({
			before: (method) => {
				if (method === "editMessageReplyMarkup" && ++edits === 1) return gate;
			},
		});
		const ratings = fakeRatings();
		const markup = {
			inline_keyboard: [
				[
					{ text: "👍", callback_data: rateCallbackData("up", "dm:1", 7) },
					{ text: "👎", callback_data: rateCallbackData("down", "dm:1", 7) },
				],
				[{ text: "🔊", callback_data: "speak_reply" }],
			],
		};
		const first = handleRateButton(query(rateCallbackData("up", "dm:1", 7), 42, 77, markup), {
			api: fake.api,
			ratings,
		});
		const second = handleRateButton(query(rateCallbackData("down", "dm:1", 7), 42, 77, markup), {
			api: fake.api,
			ratings,
		});
		await Promise.resolve();
		expect(edits).toBe(1); // The second edit waits for the first to land.
		release();
		await Promise.all([first, second]);
		expect(ratings.records.map((r) => r.rating)).toEqual(["up", "down"]);
		expect(markups(fake.calls)).toEqual([
			[[{ text: "👍", disabled: {} }], [{ text: "🔊", callback_data: "speak_reply" }]],
			[[{ text: "👎", disabled: {} }], [{ text: "🔊", callback_data: "speak_reply" }]],
		]);
	});

	test("a timed-out edit still holds its queue until the underlying request settles", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let edits = 0;
		const fake = fakeApi({
			before: (method) => {
				if (method === "editMessageReplyMarkup" && ++edits === 1) return gate;
			},
		});
		const ratings = fakeRatings();
		const markup = {
			inline_keyboard: [
				[{ text: "👍", callback_data: rateCallbackData("up", "dm:1", 7) }],
				[{ text: "🔊", callback_data: "speak_reply" }],
			],
		};
		const deps = { api: fake.api, ratings, editTimeoutMs: 10 };
		const first = handleRateButton(query(rateCallbackData("up", "dm:1", 7), 42, 78, markup), deps);
		const second = handleRateButton(
			query(rateCallbackData("down", "dm:1", 7), 42, 78, markup),
			deps,
		);
		// Keep the event loop alive: the production timeout is deliberately unref'd.
		await Promise.all([first, second, Bun.sleep(30)]);
		expect(edits).toBe(1);
		expect(ratings.records.map((r) => r.rating)).toEqual(["up", "down"]);
		expect(answers(fake.calls)).toEqual([
			"rating recorded — display may be stale",
			"rating recorded — display may be stale",
		]);
		release();
		await Bun.sleep(10);
		expect(edits).toBe(2);
		expect(markups(fake.calls)).toEqual([
			[[{ text: "👍", disabled: {} }], [{ text: "🔊", callback_data: "speak_reply" }]],
			[[{ text: "👎", disabled: {} }], [{ text: "🔊", callback_data: "speak_reply" }]],
		]);
	});

	test("a late failed edit releases its queue without blocking other messages", async () => {
		let reject!: (error: Error) => void;
		const gate = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		let edits = 0;
		const fake = fakeApi({
			before: (method) => {
				if (method === "editMessageReplyMarkup" && ++edits === 1) return gate;
			},
		});
		const markup = { inline_keyboard: [[{ text: "👍", callback_data: "rate:up|dm:1|7" }]] };
		const deps = { api: fake.api, ratings: fakeRatings(), editTimeoutMs: 10 };
		const first = handleRateButton(query("rate:up|dm:1|7", 42, 79, markup), deps);
		const second = handleRateButton(query("rate:down|dm:1|7", 42, 79, markup), deps);
		await handleRateButton(query("rate:up|dm:1|7", 42, 80, markup), deps);
		expect(edits).toBe(2);
		await Promise.all([first, second, Bun.sleep(30)]);
		expect(answers(fake.calls)).toEqual([
			"👍 recorded",
			"rating recorded — display may be stale",
			"rating recorded — display may be stale",
		]);
		reject(new Error("late network failure"));
		await Bun.sleep(10);
		expect(edits).toBe(3);
	});

	test("registration routes a rate update through a real bot — non-rate updates don't reach it", async () => {
		const fake = fakeApi();
		const ratings = fakeRatings();
		const bot = new Bot("test-token", {
			botInfo: {
				id: 99,
				is_bot: true,
				first_name: "goblin",
				username: "goblin_test_bot",
				can_join_groups: true,
				can_read_all_group_messages: true,
				supports_inline_queries: false,
				can_connect_to_business: false,
				has_main_web_app: false,
				has_topics_enabled: false,
				allows_users_to_create_topics: false,
				can_manage_bots: false,
				supports_join_request_queries: false,
			},
		});
		registerRateButton(bot, { api: fake.api, ratings });
		const tap = (data: string): Update =>
			({
				update_id: 1,
				callback_query: {
					id: "q1",
					from: { id: 1, is_bot: false, first_name: "op" },
					chat_instance: "ci",
					data,
					message: {
						message_id: 10,
						date: 0,
						chat: { id: 42, type: "private", first_name: "op" },
						text: "the reply",
					},
				},
			}) as Update;
		await bot.handleUpdate(tap(rateCallbackData("down", "dm:1:3", 7)));
		await bot.handleUpdate(tap("speak_reply"));
		expect(ratings.records).toEqual([
			{ conversationId: "dm:1:3", anchorSeq: 7, chatId: 42, messageId: 10, rating: "down" },
		]);
		expect(answers(fake.calls)).toEqual(["👎 recorded"]);
	});
});
