// A user stopping a streamed draft arrives as this update. Goblin opens no
// drafts (nothing in src/ calls sendMessageDraft), so it should never fire.
// The log line is the tripwire if Telegram sends one anyway.

import type { Bot } from "grammy";
import { log } from "../log.ts";

export function registerGenerationStop(bot: Bot): void {
	bot.on("stopped_message_generation", (ctx) => {
		const stop = ctx.stoppedMessageGeneration;
		log.info("message generation stop received", {
			update: ctx.update.update_id,
			chat: stop.chat.id,
			draft: stop.draft_id,
			thread: stop.message_thread_id ?? null,
		});
	});
}
