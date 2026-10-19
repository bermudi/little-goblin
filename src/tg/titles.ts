import type { Api } from "grammy";
import type { Conversation, ConversationMetaPatch, ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";

export interface TitleDeps {
	api: Pick<Api, "editForumTopic">;
	store: ConversationStore;
	titleFor(text: string): Promise<string | null>;
}

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
	const title = await withTimeout(deps.titleFor(firstText), "titleFor");
	if (title === null) {
		log.info("topic titling produced no name — placeholder stays", {
			conversation: conv.id,
		});
		return;
	}
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
	const afterEdit = deps.store.get(fresh.id);
	if (!afterEdit?.titleImplicit) {
		if (afterEdit?.title && afterEdit.threadId !== null) {
			await withTimeout(
				deps.api.editForumTopic(afterEdit.chatId, afterEdit.threadId, { name: afterEdit.title }),
				"editForumTopic",
			);
		}
		log.info("topic titling lost to operator rename during edit", { conversation: fresh.id });
		return;
	}
	deps.store.setMeta(fresh.id, { title, titleImplicit: false });
	log.info("topic renamed", { conversation: fresh.id, title });
}
