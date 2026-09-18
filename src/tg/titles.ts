// Topic auto-titling. A conversation flagged titleImplicit owes its topic
// a real name — Telegram set a placeholder. Generate one from the first
// text burst, then editForumTopic — but only if the flag is still set at
// edit time: a name the operator typed mid-flight always wins.

import type { Api } from "grammy";
import type { Conversation, ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";

export interface TitleDeps {
	api: Pick<Api, "editForumTopic">;
	store: ConversationStore;
	// null = no usable title this attempt (unconfigured or empty output).
	// Throws on provider failure — the caller logs and moves on.
	titleFor(text: string): Promise<string | null>;
}

export async function maybeRenameTopic(
	deps: TitleDeps,
	conv: Conversation,
	firstText: string,
): Promise<void> {
	log.debug("titling topic", { conversation: conv.id });
	const title = await deps.titleFor(firstText);
	if (title === null) return;
	// The model call gave the operator a window to rename the topic (or
	// the flag was cleared another way) — re-read and bail if the debt is
	// gone. Their name wins.
	const fresh = deps.store.get(conv.id);
	if (!fresh?.titleImplicit || fresh.threadId === null) return;
	await deps.api.editForumTopic(fresh.chatId, fresh.threadId, { name: title });
	deps.store.setMeta(fresh.id, { title, titleImplicit: false });
	log.info("topic renamed", { conversation: fresh.id, title });
}
