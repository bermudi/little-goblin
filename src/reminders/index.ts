// The reminders feature — one folder, one public surface, its own
// tables. Policy (what is due, what it says), push-first delivery with
// the Telegram fallback (which owns the tg_reminder_sends dedupe table),
// and the scheduler's sweep. Everything outside imports from here;
// the modules below are the feature's private shape.

export {
	REMINDER_EVERY_MS,
	REMINDER_FIRST_MS,
	type OperatorReminder,
	dueReminder,
	reminderText,
} from "./policy.ts";
export { deliverOperatorReminder } from "./deliver.ts";
export { openTelegramReminders } from "./telegram.ts";
export { type ReminderSweepDeps, REMINDER_RETRY_MS, sweepOperatorReminders } from "./sweep.ts";
