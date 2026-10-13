import { describe, expect, test } from "bun:test";
import { GrammyError, type RawApi, type Transformer } from "grammy";
import type { ApiResponse, Message, ResponseParameters } from "grammy/types";
import { floodWaitTransformer } from "./flood-wait.ts";

type Prev = Parameters<Transformer>[0];

// grammy constructs these internally from the api response body
// (toGrammyError): message names the method, fields lift off the body.
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

function flood429(retryAfterS: number): GrammyError {
	return grammyErr(429, { retry_after: retryAfterS });
}

const SENT: ApiResponse<Message> = {
	ok: true,
	result: {
		message_id: 7,
		date: 0,
		chat: { id: 1, type: "private", first_name: "op" },
		text: "hi",
	},
};

// Scripted api: Error entries reject, anything else resolves as the
// call result. The cast replicates grammy's internal ApiCallResult
// conditional — not exported from the package root.
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
		// concrete methods under this tsconfig; the transformer is
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

	test("a non-429 GrammyError rethrows without sleeping", async () => {
		const err = grammyErr(400, { migrate_to_chat_id: -9 });
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		await expect(
			floodWaitTransformer({ sleep })(prev, "sendMessage", { chat_id: 1, text: "hi" }),
		).rejects.toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("retry_after beyond the cap rethrows without sleeping or retrying", async () => {
		const err = flood429(61);
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		await expect(
			floodWaitTransformer({ sleep })(prev, "sendMessage", { chat_id: 1, text: "hi" }),
		).rejects.toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("more 429s than maxRetries rethrow after the capped waits", async () => {
		const last = flood429(1);
		const { prev, calls } = scriptPrev([flood429(1), flood429(1), last]);
		const { sleeps, sleep } = recordingSleep();

		await expect(
			floodWaitTransformer({ sleep })(prev, "sendMessage", { chat_id: 1, text: "hi" }),
		).rejects.toBe(last);
		expect(sleeps).toEqual([1000, 1000]);
		expect(calls).toHaveLength(3);
	});

	test("maxRetries 0 rethrows the first 429 immediately", async () => {
		const err = flood429(3);
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		await expect(
			floodWaitTransformer({ sleep, maxRetries: 0 })(prev, "sendMessage", {
				chat_id: 1,
				text: "hi",
			}),
		).rejects.toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	test("a 429 without a numeric retry_after rethrows untouched", async () => {
		const err = grammyErr(429);
		const { prev, calls } = scriptPrev([err]);
		const { sleeps, sleep } = recordingSleep();

		await expect(
			floodWaitTransformer({ sleep })(prev, "sendMessage", { chat_id: 1, text: "hi" }),
		).rejects.toBe(err);
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
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
});
