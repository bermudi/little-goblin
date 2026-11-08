// Push-first delivery with the Telegram fallback: a reminder that no app
// device took still rings, but only while it is still due — the operator
// can have answered or paused while the push was in flight.

import { log } from "../log.ts";
import type { ResponsibilityStore } from "../responsibilities.ts";
import { dueReminder, type OperatorReminder } from "./policy.ts";

export async function deliverOperatorReminder(
	reminder: OperatorReminder,
	deps: {
		push(reminder: OperatorReminder): Promise<boolean>;
		telegram(reminder: OperatorReminder): Promise<void>;
		resps: Pick<ResponsibilityStore, "get" | "latestReport" | "operationsFor">;
	},
): Promise<void> {
	if (await deps.push(reminder)) return;
	// The push may have taken a while: the operator can have answered or paused since.
	const id = reminder.responsibilityId;
	const resp = deps.resps.get(id);
	const current =
		resp === null
			? null
			: dueReminder(resp, deps.resps.latestReport(id), deps.resps.operationsFor(id), new Date());
	if (current?.key !== reminder.key) {
		log.info("operator reminder fallback skipped — no longer due", { key: reminder.key });
		return;
	}
	await deps.telegram(reminder);
}
