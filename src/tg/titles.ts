// Topic auto-titling. A conversation flagged titleImplicit owes its topic
// a real name — Telegram set a placeholder. Generate one from the first
// text burst, then editForumTopic — but only if the flag is still set at
// edit time: a rename the operator lands mid-flight wins.

import type { Api } from "grammy";
import type {
	Conversation,
	ConversationMetaPatch,
	ConversationStore,
} from "../conversation.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";

export interface TitleDeps {
	api: Pick<Api, "editForumTopic">;
	store: ConversationStore;
	// null = no usable title this attempt (unconfigured or empty output).
	// Throws on provider failure — the caller logs and moves on.
	titleFor(text: string): Promise<string | null>;
}

// forum_topic_created/edited → the meta patch it implies. Creation sets
// the titling debt only when Telegram itself admits the name is implicit;
// a named edit settles it (icon-only edits leave it alone).
export function titleMetaFromService(msg: {
	forum_topic_created?: { name: string; is_name_implicit?: boolean };
	forum_topic_edited?: { name?: string };
}): ConversationMetaPatch | undefined {
	if (msg.forum_topic_created) {
		return {
			title: msg.forum_topic_created.name,
			titleImplicit: msg.forum_topic_created.is_name_implicit === true,
		};
	}
	const edited = msg.forum_topic_edited?.name;
	if (edited !== undefined) return { title: edited, titleImplicit: false };
	return undefined;
}

export async function maybeRenameTopic(
	deps: TitleDeps,
	conv: Conversation,
	firstText: string,
): Promise<void> {
	log.info("titling topic", { conversation: conv.id });
	// Bounded like every external call — a wedged provider must not burn
	// the conversation's one attempt silently.
	const title = await withTimeout(deps.titleFor(firstText), "titleFor");
	if (title === null) {
		log.info("topic titling produced no name — placeholder stays", {
			conversation: conv.id,
		});
		return;
	}
	// The model call gave the operator a window to rename the topic (or
	// the debt was settled another way) — re-read and bail if the flag is
	// gone. A rename committed server-side but not yet delivered can still
	// be clobbered; that's Telegram's API ceiling, not a choice.
	const fresh = deps.store.get(conv.id);
	if (!fresh?.titleImplicit || fresh.threadId === null) {
		log.info("topic titling skipped — debt already settled", {
			conversation: conv.id,
		});
		return;
	}
	await withTimeout(
		deps.api.editForumTopic(fresh.chatId, fresh.threadId, { name: title }),
		"editForumTopic",
	);
	deps.store.setMeta(fresh.id, { title, titleImplicit: false });
	log.info("topic renamed", { conversation: fresh.id, title });
}
