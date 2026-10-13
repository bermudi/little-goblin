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
	// False when the demanded wait is out of budget — the caller then
	// returns/throws the original failure untouched.
	const honored = async (retryAfterS: number, attempt: number, method: string): Promise<boolean> => {
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
			// grammy resolves the raw ApiResponse through the transformer
			// chain — a 429 rides back as a resolved {ok:false} VALUE; the
			// GrammyError is raised above the chain in callApi, so a catch
			// here would never see it. The throw channel still gets the
			// same check: network failures reach here as errors, and a
			// transformer stacked under this one can raise a GrammyError
			// of its own.
			let res;
			try {
				res = await prev(method, payload, signal);
			} catch (err) {
				const retryAfterS = floodRetryAfter(err);
				if (retryAfterS === undefined || !(await honored(retryAfterS, attempt, method)))
					throw err;
				continue;
			}
			const retryAfterS = floodRetryAfter(res);
			if (retryAfterS === undefined || !(await honored(retryAfterS, attempt, method)))
				return res;
		}
	};
}

// Numeric retry_after from either channel: a resolved {ok:false} body
// (grammy's real contract at this layer) or a thrown GrammyError.
// Only a 429 carrying the parameter is waitable; anything else — other
// errors, or a 429 without it — passes through untouched.
function floodRetryAfter(source: unknown): number | undefined {
	if (source instanceof GrammyError) {
		if (source.error_code !== 429) return undefined;
		const retryAfter = source.parameters.retry_after;
		return typeof retryAfter === "number" ? retryAfter : undefined;
	}
	if (typeof source !== "object" || source === null || !("ok" in source)) return undefined;
	const body = source as {
		ok: boolean;
		error_code?: number;
		parameters?: { retry_after?: unknown };
	};
	if (body.ok !== false || body.error_code !== 429) return undefined;
	const retryAfter = body.parameters?.retry_after;
	return typeof retryAfter === "number" ? retryAfter : undefined;
}
