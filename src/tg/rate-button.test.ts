// The 👍/👎 tap's boundaries: the payload round-trips, the row lands
// before the toast answers, edge taps get an honest answer — plus the
// grammy routing the registration installs.

import { describe, expect, test } from "bun:test";
import { Bot, type Api } from "grammy";
import type { Update } from "grammy/types";
import {
	handleRateButton,
	rateCallbackData,
	registerRateButton,
	type RateQuery,
} from "./rate-button.ts";
import type { ReplyRatings, ReplyRatingWrite } from "./ratings.ts";

interface ApiCall {
	method: string;
	args: unknown[];
}

function fakeApi(calls: ApiCall[]): Api {
	return {
		answerCallbackQuery: ((id: string, opts?: unknown) => {
			calls.push({ method: "answerCallbackQuery", args: [id, opts] });
			return Promise.resolve(true);
		}),
	} as unknown as Api;
}

function answers(calls: ApiCall[]): (string | undefined)[] {
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
	};
}

function query(data: string | undefined, chatId = 1, messageId = 10): RateQuery {
	return {
		id: `q-${messageId}`,
		data,
		message: { message_id: messageId, chat: { id: chatId } },
	};
}

describe("rate button", () => {
	test("a tap records the row with the payload's target, then toasts", async () => {
		const calls: ApiCall[] = [];
		const ratings = fakeRatings();
		await handleRateButton(query(rateCallbackData("up", "dm:1:3", 7), 42, 10), {
			api: fakeApi(calls),
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
		expect(answers(calls)).toEqual(["👍 recorded"]);
	});

	test("a landed reply with no user anchor records a null anchor", async () => {
		const calls: ApiCall[] = [];
		const ratings = fakeRatings();
		await handleRateButton(query(rateCallbackData("down", "topic:-100:9", null)), {
			api: fakeApi(calls),
			ratings,
		});
		expect(ratings.records[0]).toMatchObject({ anchorSeq: null, rating: "down" });
		expect(answers(calls)).toEqual(["👎 recorded"]);
	});

	test("a malformed payload is answered stale, nothing recorded", async () => {
		const calls: ApiCall[] = [];
		const ratings = fakeRatings();
		await handleRateButton(query("rate:sideways|dm:1|7"), { api: fakeApi(calls), ratings });
		await handleRateButton(query(undefined), { api: fakeApi(calls), ratings });
		expect(ratings.records).toEqual([]);
		expect(answers(calls)).toEqual(["that button is stale", "that button is stale"]);
	});

	test("a query without a message can't record", async () => {
		const calls: ApiCall[] = [];
		const ratings = fakeRatings();
		await handleRateButton(
			{ id: "q1", data: rateCallbackData("up", "dm:1", 1) },
			{ api: fakeApi(calls), ratings },
		);
		expect(ratings.records).toEqual([]);
		expect(answers(calls)).toEqual(["nothing to rate here"]);
	});

	test("a store failure still answers — the toast carries the outcome", async () => {
		const calls: ApiCall[] = [];
		const ratings = fakeRatings(true);
		await handleRateButton(query(rateCallbackData("up", "dm:1", 1)), {
			api: fakeApi(calls),
			ratings,
		});
		expect(answers(calls)).toEqual(["rating not recorded — check the log"]);
	});

	test("registration routes a rate update through a real bot — non-rate updates don't reach it", async () => {
		const calls: ApiCall[] = [];
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
		registerRateButton(bot, { api: fakeApi(calls), ratings });
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
		expect(answers(calls)).toEqual(["👎 recorded"]);
	});
});
