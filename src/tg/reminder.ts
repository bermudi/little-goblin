// Telegram fallback for an operator reminder that reached no app device.
// The sent table is the durable dedupe: the sweep retries a failed chat,
// and a restart must not ring a chat again for the same step.

import type { Database } from "bun:sqlite";
import { appLink } from "../app-link.ts";
import { appIdOf } from "../conversation.ts";
import { log } from "../log.ts";
import { type OperatorReminder, reminderText } from "../responsibility-reminder.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import type { DeliveryApi } from "./delivery.ts";
import type { PingStore } from "./pings.ts";

export interface TelegramReminderDeps {
	db: Database;
	pings: PingStore;
	/** Null while the channel is detached or disabled. */
	api(): DeliveryApi | null;
	operators(): number[];
	publicUrl(): string | undefined;
	timeoutMs?: number;
}

export function openTelegramReminders(
	deps: TelegramReminderDeps,
): (reminder: OperatorReminder) => Promise<void> {
	deps.db.run(`CREATE TABLE IF NOT EXISTS tg_reminder_sends (
		reminder_key TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		sent_at TEXT NOT NULL,
		PRIMARY KEY (reminder_key, chat_id)
	)`);
	const qSent = deps.db.query<{ n: number }, [string, number]>(
		"SELECT COUNT(*) AS n FROM tg_reminder_sends WHERE reminder_key = ? AND chat_id = ?",
	);
	const qMark = deps.db.query(
		"INSERT OR IGNORE INTO tg_reminder_sends (reminder_key, chat_id, sent_at) VALUES (?, ?, ?)",
	);

	return async (reminder) => {
		const fields = { key: reminder.key, conversation: reminder.conversationId };
		const api = deps.api();
		if (api === null) {
			log.warn("operator reminder undelivered — no app device, telegram unavailable", fields);
			return;
		}
		const appId = appIdOf(reminder.conversationId);
		const publicUrl = deps.publicUrl();
		await Promise.all(
			deps.operators().map(async (chat) => {
				if ((qSent.get(reminder.key, chat)?.n ?? 0) > 0) return;
				const sending = api.sendMessage(
					chat,
					reminderText(reminder.stage),
					appId === null || publicUrl === undefined
						? {}
						: {
								reply_markup: {
									inline_keyboard: [[{ text: "Open in app", url: appLink(publicUrl, appId) }]],
								},
							},
				);
				let messageId: number;
				try {
					messageId = (
						await withTimeout(sending, "sendMessage (operator reminder)", deps.timeoutMs)
					).message_id;
				} catch (err) {
					if (!(err instanceof TelegramTimeoutError)) {
						log.warn("operator reminder telegram send failed — will retry", {
							...fields,
							chat,
							error: err instanceof Error ? err.message : String(err),
						});
						return;
					}
					// A timeout never proves non-delivery. The sweep won't retry a
					// key that is still in flight, so keep waiting for the real result.
					log.warn("operator reminder delivery uncertain — waiting for late result", {
						...fields,
						chat,
					});
					try {
						messageId = (await sending).message_id;
					} catch (late) {
						log.warn("operator reminder telegram send failed — will retry", {
							...fields,
							chat,
							error: late instanceof Error ? late.message : String(late),
						});
						return;
					}
				}
				// Persistence failures propagate: they are not send failures.
				deps.db.transaction(() => {
					qMark.run(reminder.key, chat, new Date().toISOString());
					// A swipe reply reaches the waiting app conversation, as with the bell.
					if (appId !== null) deps.pings.record(chat, messageId, reminder.conversationId);
				})();
				log.info("operator reminder sent on telegram", { ...fields, chat });
			}),
		);
	};
}
