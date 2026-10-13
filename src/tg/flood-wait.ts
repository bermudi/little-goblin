// Flood control — the one api transformer that honors Telegram's
// retry_after on every outbound call. The reply drain awaits its
// in-flight send chain each iteration, so a 429 wait that resolves
// inside this transformer is invisible to its stagnant ladder and
// costs it nothing; left un-honored, three resolved failures in ~2s
// drop the answer's tail — and one-shot sends (bell, notify,
// commands) fail outright.

import { GrammyError, type Transformer } from "grammy";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Waits stay bounded so a drain or one-shot send cannot park on the
// clock indefinitely — beyond the cap the failure propagates to the
// caller's existing uncertainty/failure handling, fail loud.
const DEFAULT_MAX_WAIT_MS = 60_000;
// Honored waits per api call — a cap, not a promise to succeed.
const DEFAULT_MAX_RETRIES = 2;

export interface FloodWaitOpts {
	maxWaitMs?: number;
	maxRetries?: number;
	sleep?: (ms: number) => Promise<void>;
}

export function floodWaitTransformer(opts: FloodWaitOpts = {}): Transformer {
	const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
	const wait = opts.sleep ?? sleep;
	// Whether to wait out this retry_after and retry. Caps and logging
	// live here once — a real 429 resolves as {ok:false} data (the
	// GrammyError is built after transformers run), while an upstream
	// transformer can still throw one.
	const honor = async (
		method: string,
		retryAfterS: number,
		attempt: number,
	): Promise<boolean> => {
		const demanded = retryAfterS * 1000;
		if (demanded > maxWaitMs) {
			log.warn("telegram flood wait beyond cap", { method, retryAfterS });
			return false;
		}
		if (attempt >= maxRetries) {
			log.warn("telegram flood wait retries exhausted", { method, retryAfterS });
			return false;
		}
		log.warn("telegram flood wait", { method, retryAfterS, attempt: attempt + 1 });
		await wait(demanded);
		return true;
	};
	return async (prev, method, payload, signal) => {
		for (let attempt = 0; ; attempt++) {
			try {
				const envelope = await prev(method, payload, signal);
				if (envelope.ok) return envelope;
				const retryAfterS = floodRetryAfter(envelope);
				if (retryAfterS === undefined || !(await honor(method, retryAfterS, attempt)))
					return envelope;
			} catch (err) {
				const retryAfterS = floodRetryAfter(err);
				if (retryAfterS === undefined || !(await honor(method, retryAfterS, attempt)))
					throw err;
			}
		}
	};
}

// Only a 429 carrying a numeric retry_after is waitable; anything
// else — other errors, or a 429 without the parameter — passes through
// to the caller's normal failure handling.
function floodRetryAfter(err: unknown): number | undefined {
	if (err instanceof GrammyError) {
		if (err.error_code !== 429) return undefined;
		const retryAfter = err.parameters.retry_after;
		return typeof retryAfter === "number" ? retryAfter : undefined;
	}
	// The resolved failure envelope: transformers run before callApi
	// turns {ok:false} into a GrammyError, so a real 429 arrives as
	// data — {ok:false, error_code:429, parameters:{retry_after}}.
	if (typeof err === "object" && err !== null) {
		const envelope = err as {
			error_code?: unknown;
			parameters?: { retry_after?: unknown };
		};
		if (envelope.error_code !== 429) return undefined;
		const retryAfter = envelope.parameters?.retry_after;
		return typeof retryAfter === "number" ? retryAfter : undefined;
	}
	return undefined;
}
