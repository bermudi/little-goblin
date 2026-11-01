import { describe, expect, test } from "bun:test";
import { type ApiClientOptions, Bot } from "grammy";
import { makeBotCleanup } from "./cleanup.ts";
import type { RunningBot } from "./mod.ts";

function fixture(failStop: boolean, failDrain: boolean) {
	const calls: string[] = [];
	const gate = Promise.withResolvers<void>();
	const running = {
		bot: {
			isRunning: () => true,
			stop: async () => {
				calls.push("stop");
				await gate.promise;
				if (failStop) throw new Error("stop broke");
			},
		},
		waitForPolling: async () => {},
		drainIntake: async () => {
			calls.push("drain");
			if (failDrain) throw new Error("drain broke");
		},
	} as unknown as RunningBot;
	return { running, calls, gate };
}

describe("telegram bot cleanup", () => {
	test("shutdown and failed attach share one stop and drain", async () => {
		const f = fixture(false, false);
		const cleanup = makeBotCleanup();
		const first = cleanup(f.running);
		const second = cleanup(f.running);
		expect(first).toBe(second);
		f.gate.resolve();
		await first;
		expect(f.calls).toEqual(["stop", "drain"]);
	});

	test("joins grammY middleware before the final intake drain", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let updates = 0;
		let drained = false;
		const bot = new Bot("test", {
			botInfo: {
				id: 1,
				is_bot: true,
				first_name: "Test",
				username: "test_bot",
				can_join_groups: true,
				can_read_all_group_messages: false,
				supports_inline_queries: false,
				can_connect_to_business: false,
				has_main_web_app: false,
				has_topics_enabled: false,
				allows_users_to_create_topics: false,
				can_manage_bots: false,
				supports_join_request_queries: false,
			},
			client: {
				fetch: (async (url: unknown) => {
					if (String(url).endsWith("/deleteWebhook"))
						return Response.json({ ok: true, result: true });
					if (!String(url).endsWith("/getUpdates")) throw new Error(`unexpected request ${url}`);
					updates++;
					if (updates === 1)
						return Response.json({
							ok: true,
							result: [
								{
									update_id: 1,
									message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "hi" },
								},
							],
						});
					stopped.resolve();
					return Response.json({ ok: true, result: [] });
				}) as unknown as NonNullable<ApiClientOptions["fetch"]>,
			},
		});
		bot.use(async () => {
			entered.resolve();
			await release.promise;
		});
		const polling = bot.start();
		await entered.promise;
		const running = {
			bot,
			waitForPolling: () => polling,
			drainIntake: async () => {
				drained = true;
			},
		} as unknown as RunningBot;
		const cleanup = makeBotCleanup()(running);
		await stopped.promise;
		await Promise.resolve();
		expect(drained).toBe(false);
		release.resolve();
		await cleanup;
		expect(drained).toBe(true);
	});

	test("both failures are preserved and a failed cleanup is not retried", async () => {
		const f = fixture(true, true);
		const cleanup = makeBotCleanup();
		const first = cleanup(f.running);
		f.gate.resolve();
		try {
			await first;
			throw new Error("expected cleanup failure");
		} catch (err) {
			expect(err).toBeInstanceOf(AggregateError);
			const errors = (err as AggregateError).errors as Error[];
			expect(errors.map((e) => e.message)).toEqual([
				"telegram poll stop failed",
				"telegram intake drain failed",
			]);
			expect(errors.map((e) => String(e.cause))).toEqual([
				"Error: stop broke",
				"Error: drain broke",
			]);
		}
		expect(cleanup(f.running)).toBe(first);
		expect(f.calls).toEqual(["stop", "drain"]);
	});
});
