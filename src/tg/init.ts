import type { Bot } from "grammy";
import { API_CALL_TIMEOUT_MS, TelegramTimeoutError } from "./deadline.ts";

// Unlike delivery calls, initialization must not be abandoned: grammY retries
// getMe itself, and a discarded init would keep retrying beside its successor.
// Abort its fetch/retry loop at the deadline and join it before returning.
export async function initializeBot(bot: Bot, ms = API_CALL_TIMEOUT_MS): Promise<void> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ms);
	timer.unref();
	try {
		// grammY's Node declarations use abort-controller's structurally
		// incompatible signal type; its runtime only uses the standard events.
		await bot.init(controller.signal as unknown as NonNullable<Parameters<Bot["init"]>[0]>);
	} catch (err) {
		if (!timedOut) throw err;
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) throw new TelegramTimeoutError("getMe", ms);
}
