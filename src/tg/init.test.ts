import { describe, expect, jest, test } from "bun:test";
import { type ApiClientOptions, Bot } from "grammy";
import { TelegramTimeoutError } from "./deadline.ts";
import { initializeBot } from "./init.ts";

describe("Telegram initialization", () => {
	test("aborts a retried hanging getMe and joins it before a replacement", async () => {
		jest.useFakeTimers();
		try {
			const secondRequest = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let requests = 0;
			const bot = new Bot("test", {
				client: {
					fetch: (async (_url: unknown, options?: { signal?: AbortSignal | null }) => {
						requests++;
						if (requests === 1) throw new Error("transport failure");
						secondRequest.resolve();
						const signal = options?.signal;
						if (!signal) throw new Error("missing fetch signal");
						signal.addEventListener("abort", () => aborted.resolve(), { once: true });
						await release.promise;
						throw new Error("fetch settled after abort");
					}) as NonNullable<ApiClientOptions["fetch"]>,
				},
			});
			let replaced = false;
			let result: unknown;
			const attempt = initializeBot(bot, 30_000).catch((err: unknown) => {
				result = err;
				replaced = true;
			});
			await secondRequest.promise;
			expect(requests).toBe(2);
			jest.advanceTimersByTime(30_000);
			await aborted.promise;
			expect(replaced).toBe(false);
			release.resolve();
			await attempt;
			expect(result).toEqual(new TelegramTimeoutError("getMe", 30_000));
			expect(replaced).toBe(true);
			jest.advanceTimersByTime(60_000);
			await Promise.resolve();
			expect(requests).toBe(2);
		} finally {
			jest.useRealTimers();
		}
	});

	test("propagates a non-retryable getMe failure", async () => {
		const bot = new Bot("test", {
			client: {
				fetch: async () =>
					Response.json({ ok: false, error_code: 401, description: "Unauthorized" }),
			},
		});
		await expect(initializeBot(bot)).rejects.toThrow("Unauthorized");
	});
});
