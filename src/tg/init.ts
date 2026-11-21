import type { Bot } from "grammy";
import { deadline } from "../timing.ts";
import { API_CALL_TIMEOUT_MS, TelegramTimeoutError } from "./deadline.ts";

// Unlike delivery calls, initialization must not be abandoned: grammY retries
// getMe itself, and a discarded init would keep retrying beside its successor.
// Abort its fetch/retry loop at the deadline and join it before returning.
export async function initializeBot(bot: Bot, ms = API_CALL_TIMEOUT_MS): Promise<void> {
	using limit = deadline(ms, undefined, { unref: true });
	try {
		// grammY's Node declarations use abort-controller's structurally
		// incompatible signal type; its runtime only uses the standard events.
		await bot.init(limit.signal as unknown as NonNullable<Parameters<Bot["init"]>[0]>);
	} catch (err) {
		if (!limit.expired()) throw err;
	}
	if (limit.expired()) throw new TelegramTimeoutError("getMe", ms);
}
