import { GrammyError, type Transformer } from "grammy";
import { log } from "../log.ts";
import { API_CALL_TIMEOUT_MS } from "./deadline.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEFAULT_MAX_WAIT_MS = API_CALL_TIMEOUT_MS - 10_000;
const ANSWER_MAX_WAIT_MS = 5_000;
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
		let remainingMs = method.startsWith("answer")
			? Math.min(maxWaitMs, ANSWER_MAX_WAIT_MS)
			: maxWaitMs;
		const honored = async (
			retryAfterS: number,
			attempt: number,
			method: string,
		): Promise<boolean> => {
			const demanded = retryAfterS * 1000;
			if (demanded > remainingMs) {
				log.warn("telegram flood wait beyond cap", { method, retryAfterS });
				return false;
			}
			if (attempt >= maxRetries) {
				log.warn("telegram flood wait retries exhausted", { method, retryAfterS });
				return false;
			}
			log.warn("telegram flood wait", { method, retryAfterS, attempt: attempt + 1 });
			remainingMs -= demanded;
			await wait(demanded);
			return true;
		};
		for (let attempt = 0; ; attempt++) {
			// grammy resolves a 429 body as {ok:false} at this layer —
			// GrammyError is raised above the chain, in callApi.
			let res;
			try {
				res = await prev(method, payload, signal);
			} catch (err) {
				const retryAfterS = floodRetryAfter(err);
				if (retryAfterS === undefined || !(await honored(retryAfterS, attempt, method))) throw err;
				continue;
			}
			const retryAfterS = floodRetryAfter(res);
			if (retryAfterS === undefined || !(await honored(retryAfterS, attempt, method))) return res;
		}
	};
}

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
