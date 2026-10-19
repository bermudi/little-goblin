import { describe, expect, test } from "bun:test";
import { Api, GrammyError, type RawApi, type Transformer } from "grammy";
import type { ApiResponse, Message, ResponseParameters } from "grammy/types";
import { floodWaitTransformer } from "./flood-wait.ts";

type Prev = Parameters<Transformer>[0];

// The real grammy contract: the transformer chain resolves the raw
// ApiResponse body — an API failure is a resolved {ok:false} value,
// never a throw; callApi raises the GrammyError above the chain.
function apiError(errorCode: number, params?: ResponseParameters): ApiResponse<never> {
	return {
		ok: false,
		error_code: errorCode,
		description: "boom",
		...(params ? { parameters: params } : {}),
	} as ApiResponse<never>;
}

function flood429(retryAfterS: number): ApiResponse<never> {
	return apiError(429, { retry_after: retryAfterS });
}

// callApi throws the GrammyError above us, so at this layer one only
// arrives when a transformer stacked under this one raises it.
function grammyErr(errorCode: number, params?: ResponseParameters): GrammyError {
	return new GrammyError(
		"Call to 'sendMessage' failed!",
		{
			ok: false,
			error_code: errorCode,
			description: "boom",
			...(params ? { parameters: params } : {}),
		},
		"sendMessage",
		{ chat_id: 1, text: "hi" },
	);
}

const SENT: ApiResponse<Message.TextMessage> = {
	ok: true,
	result: {
		message_id: 7,
		date: 0,
		chat: { id: 1, type: "private", first_name: "op" },
		text: "hi",
	},
};

// Error entries reject (network-class failures); anything else resolves
// as the call result, {ok:false} bodies included. The cast replicates
// grammy's internal ApiCallResult conditional — not exported.
function scriptPrev(script: unknown[]) {
	const calls: Array<{ method: string; payload: unknown }> = [];
	const prev: Prev = async (method, payload) => {
		calls.push({ method, payload });
		const next = script.shift();
		if (next === undefined) throw new Error("script exhausted");
		if (next instanceof Error) throw next;
		return next as ApiResponse<
			RawApi[typeof method] extends (...args: unknown[]) => unknown
				? Awaited<ReturnType<RawApi[typeof method]>>
				: never
		>;
	};
	return { prev, calls };
}

// Immediate-resolve sleep recorder — waits are observed, not awaited.
function recordingSleep() {
	const sleeps: number[] = [];
	return {
		sleeps,
		sleep: (ms: number): Promise<void> => {
			sleeps.push(ms);
			return Promise.resolve();
		},
	};
}

describe("floodWaitTransformer", () => {
	test("429 then success waits the demanded time and retries the same call", async () => {
		const err = flood429(5);
		const { prev, calls } = scriptPrev([err, SENT]);
		const { sleeps, sleep } = recordingSleep();

		// grammy's ApiCallResult conditional resolves to never for
		// concrete methods under this tsconfig — the transformer is
		// pass-through, so this widened envelope is the real contract.
		const res: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});

		expect(res).toEqual(SENT);
		expect(sleeps).toEqual([5000]);
		expect(calls).toHaveLength(2);
		expect(calls.every((c) => c.method === "sendMessage")).toBe(true);
		const [first, retried] = calls;
		expect(first?.payload).toEqual(retried?.payload);
	});

	test("a fresh retry_after on each 429 is honored too", async () => {
		const { prev, calls } = scriptPrev([flood429(2), flood429(7), SENT]);
		const { sleeps, sleep } = recordingSleep();

		const res: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});

		expect(res).toEqual(SENT);
		expect(sleeps).toEqual([2000, 7000]);
		expect(calls).toHaveLength(3);
	});

	test("a non-429 failure body passes through without sleeping", async () => {
		const err = apiError(400, { migrate_to_chat_id: -9 });
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		const res = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		expect(res).toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("retry_after beyond the cap returns the failure body without sleeping or retrying", async () => {
		const err = flood429(61);
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		const res = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		expect(res).toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("more 429s than maxRetries returns the last body after the capped waits", async () => {
		const last = flood429(1);
		const { prev, calls } = scriptPrev([flood429(1), flood429(1), last]);
		const { sleeps, sleep } = recordingSleep();

		const res = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		expect(res).toBe(last);
		expect(sleeps).toEqual([1000, 1000]);
		expect(calls).toHaveLength(3);
	});

	test("maxRetries 0 returns the first 429 immediately", async () => {
		const err = flood429(3);
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		const res = await floodWaitTransformer({ sleep, maxRetries: 0 })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		expect(res).toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("a 429 without a numeric retry_after passes through untouched", async () => {
		const err = apiError(429);
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		const res = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		expect(res).toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("a thrown GrammyError 429 from a stacked transformer is still honored", async () => {
		const err = grammyErr(429, { retry_after: 4 });
		const { prev, calls } = scriptPrev([err, SENT]);
		const { sleeps, sleep } = recordingSleep();

		const res: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		expect(res).toEqual(SENT);
		expect(sleeps).toEqual([4000]);
		expect(calls).toHaveLength(2);
	});

	test("a plain Error rethrows untouched", async () => {
		const err = new Error("network down");
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		await expect(
			floodWaitTransformer({ sleep })(prev, "sendMessage", { chat_id: 1, text: "hi" }),
		).rejects.toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	// End-to-end through a real Api client — the retry must happen even
	// though the 429 resolves as data and the GrammyError is raised
	// above the chain.
	test("through the real Api client: a 429 response is waited and retried", async () => {
		const fetches: string[] = [];
		const api = new Api("12345:test-token", {
			apiRoot: "http://127.0.0.1:1",
			fetch: (async (input: Parameters<typeof fetch>[0]) => {
				fetches.push(String(input));
				const body =
					fetches.length === 1
						? {
								ok: false,
								error_code: 429,
								description: "Too Many Requests: retry after 3",
								parameters: { retry_after: 3 },
							}
						: SENT;
				return new Response(JSON.stringify(body), { status: 200 });
			}) as unknown as typeof fetch,
		});
		const { sleeps, sleep } = recordingSleep();
		api.config.use(floodWaitTransformer({ sleep }));

		const message = await api.sendMessage(1, "hi");
		expect(message).toEqual(SENT.result);
		expect(sleeps).toEqual([3000]);
		expect(fetches).toHaveLength(2);
	});

	test("through the real Api client: exhaustion surfaces the GrammyError to the caller", async () => {
		const api = new Api("12345:test-token", {
			apiRoot: "http://127.0.0.1:1",
			fetch: (() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							ok: false,
							error_code: 429,
							description: "Too Many Requests: retry after 1",
							parameters: { retry_after: 1 },
						}),
						{ status: 429 },
					),
				)) as unknown as typeof fetch,
		});
		const { sleeps, sleep } = recordingSleep();
		api.config.use(floodWaitTransformer({ sleep }));

		const err = await api.sendMessage(1, "hi").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GrammyError);
		expect((err as GrammyError).error_code).toBe(429);
		expect(sleeps).toEqual([1000, 1000]);
	});
});

describe("floodWaitTransformer — raw failure envelopes", () => {
	const raw429 = (retryAfterS?: number): ApiResponse<Message> => ({
		ok: false,
		error_code: 429,
		description: "Too Many Requests",
		...(retryAfterS === undefined ? {} : { parameters: { retry_after: retryAfterS } }),
	});

	test("a raw 429 waits retry_after and retries the same call", async () => {
		const fail = raw429(5);
		const { prev, calls } = scriptPrev([fail, SENT]);
		const { sleeps, sleep } = recordingSleep();

		const res: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});

		expect(res).toEqual(SENT);
		expect(sleeps).toEqual([5000]);
		expect(calls).toHaveLength(2);
		expect(calls.every((c) => c.method === "sendMessage")).toBe(true);
	});

	test("a raw 429 beyond the cap returns the envelope for callApi's error path", async () => {
		const fail = raw429(61);
		const { prev, calls } = scriptPrev([fail]);
		const { sleeps, sleep } = recordingSleep();

		const res: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});

		expect(res).toBe(fail);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("exhausted raw 429s return the last envelope", async () => {
		const last = raw429(1);
		const { prev, calls } = scriptPrev([raw429(1), raw429(1), last]);
		const { sleeps, sleep } = recordingSleep();

		const res: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});

		expect(res).toBe(last);
		expect(sleeps).toEqual([1000, 1000]);
		expect(calls).toHaveLength(3);
	});

	test("a raw non-429 failure and a 429 without retry_after pass through", async () => {
		const bad: ApiResponse<Message> = { ok: false, error_code: 400, description: "bad" };
		const noAfter = raw429();
		const { prev, calls } = scriptPrev([bad, noAfter]);
		const { sleeps, sleep } = recordingSleep();

		const first: ApiResponse<Message> = await floodWaitTransformer({ sleep })(prev, "sendMessage", {
			chat_id: 1,
			text: "hi",
		});
		const second: ApiResponse<Message> = await floodWaitTransformer({ sleep })(
			prev,
			"sendMessage",
			{ chat_id: 1, text: "hi" },
		);
		expect(first).toBe(bad);
		expect(second).toBe(noAfter);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(2);
	});
});
