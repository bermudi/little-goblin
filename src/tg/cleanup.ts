import { log } from "../log.ts";
import type { RunningBot } from "./bot.ts";

// One cleanup per owned bot, even when shutdown races a failed attach.
// Both operations are attempted; a failure means it is unsafe to retry attach.
export function makeBotCleanup(): (running: RunningBot) => Promise<void> {
	const cleanups = new WeakMap<RunningBot, Promise<void>>();
	return (running) => {
		const existing = cleanups.get(running);
		if (existing !== undefined) return existing;
		const cleanup = (async () => {
			const errors: Error[] = [];
			const step = async (name: string, action: () => Promise<void>): Promise<void> => {
				try {
					await action();
				} catch (err) {
					log.error("telegram cleanup step failed", err, { step: name });
					errors.push(new Error(`${name} failed`, { cause: err }));
				}
			};
			await step("telegram poll stop", async () => {
				if (running.bot.isRunning()) await running.bot.stop();
			});
			// stop() cancels polling but does not join in-flight middleware.
			// No final drain can be authoritative until bot.start() settles.
			await step("telegram poll join", () => running.waitForPolling());
			await step("telegram intake drain", () => running.drainIntake());
			if (errors.length > 0) throw new AggregateError(errors, "telegram bot cleanup failed");
		})();
		cleanups.set(running, cleanup);
		return cleanup;
	};
}
