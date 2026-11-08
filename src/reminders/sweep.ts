// The scheduler's reminder sweep: which responsibilities still wait on
// the operator, deduped across ticks and restarts by the send owners'
// durable markers. Runs apart from the follow-up Programs, so a future
// commitment or a disabled Program can't silence a reminder. The push
// owner's sent markers are the durable dedupe; this only stops a failing
// or absent device from being retried every tick.

import { log } from "../log.ts";
import type { ResponsibilityStore } from "../responsibilities.ts";
import { dueReminder, type OperatorReminder } from "./policy.ts";

export const REMINDER_RETRY_MS = 15 * 60_000;

export interface ReminderSweepDeps {
	remindOperator?: ((reminder: OperatorReminder) => Promise<void>) | undefined;
	responsibilities?:
		| Pick<ResponsibilityStore, "get" | "open" | "latestReport" | "operationsFor">
		| undefined;
}

export function sweepOperatorReminders(
	deps: ReminderSweepDeps,
	now: Date,
	attempts: Map<string, number>,
	inFlight: Map<string, Promise<void>>,
): void {
	const remind = deps.remindOperator;
	const resps = deps.responsibilities;
	if (remind === undefined || resps === undefined) return;
	const due = new Set<string>();
	for (const resp of resps.open()) {
		const id = resp.responsibilityId;
		const reminder = dueReminder(resp, resps.latestReport(id), resps.operationsFor(id), now);
		if (reminder === null) continue;
		due.add(reminder.key);
		if (inFlight.has(reminder.key)) continue;
		const last = attempts.get(reminder.key);
		if (last !== undefined && now.getTime() - last < REMINDER_RETRY_MS) continue;
		attempts.set(reminder.key, now.getTime());
		log.debug("operator reminder due", { ...reminder });
		inFlight.set(
			reminder.key,
			remind(reminder)
				.catch((err: unknown) => {
					log.error("operator reminder failed", err, { ...reminder });
				})
				.finally(() => {
					inFlight.delete(reminder.key);
				}),
		);
	}
	for (const key of attempts.keys()) if (!due.has(key)) attempts.delete(key);
}
