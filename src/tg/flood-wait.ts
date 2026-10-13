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
	return async (prev, method, payload, signal) => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await prev(method, payload, signal);
			} catch (err) {
				const retryAfterS = floodRetryAfter(err);
				if (retryAfterS === undefined) throw err;
				const demanded = retryAfterS * 1000;
				if (demanded > maxWaitMs) {
					log.warn("telegram flood wait beyond cap", { method, retryAfterS });
					throw err;
				}
				if (attempt >= maxRetries) {
					log.warn("telegram flood wait retries exhausted", { method, retryAfterS });
					throw err;
				}
				log.warn("telegram flood wait", { method, retryAfterS, attempt: attempt + 1 });
				await wait(demanded);
			}
		}
	};
}

// Only a 429 carrying a numeric retry_after is waitable; anything
// else — other errors, or a 429 without the parameter — rethrows.
function floodRetryAfter(err: unknown): number | undefined {
	if (!(err instanceof GrammyError) || err.error_code !== 429) return undefined;
	const retryAfter = err.parameters.retry_after;
	return typeof retryAfter === "number" ? retryAfter : undefined;
}
