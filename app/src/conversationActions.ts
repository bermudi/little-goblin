import type { AppConversationList } from "../../src/http/app-wire.ts";
import { patchConversation } from "./api.ts";
import { flatLine, flatTitle } from "./flatText.ts";

type Conversation = AppConversationList["conversations"][number];

export type ConversationActionOptions = {
	token: string | null;
	onToggleArchived: (id: string, archived: boolean) => void;
	onTogglePinned: (id: string, pinned: boolean) => void;
	onDelete: (conv: Conversation) => void;
	onError: (message: string) => void;
};

export function conversationActionName(conv: Conversation): string {
	const title = flatTitle(conv.title);
	const preview = flatLine(conv.preview);
	return title ?? (preview === "" ? "this conversation" : preview);
}

export function conversationActions(
	conv: Conversation,
	{ token, onToggleArchived, onTogglePinned, onDelete, onError }: ConversationActionOptions,
) {
	const failed = (verb: string) => (err: unknown) =>
		onError(
			`Couldn't ${verb} "${conversationActionName(conv)}": ` +
				(err instanceof Error ? err.message : String(err)),
		);
	const toggleArchived = () =>
		patchConversation(token, conv.id, { archived: conv.archivedAt === null }).then(
			() => onToggleArchived(conv.id, conv.archivedAt === null),
			failed(conv.archivedAt === null ? "archive" : "unarchive"),
		);
	const togglePinned = () =>
		patchConversation(token, conv.id, { pinned: conv.pinnedAt === null }).then(
			() => onTogglePinned(conv.id, conv.pinnedAt === null),
			failed(conv.pinnedAt === null ? "pin" : "unpin"),
		);
	const remove = () => onDelete(conv);
	return { toggleArchived, togglePinned, remove };
}
