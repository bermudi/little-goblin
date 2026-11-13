// Recent reply texts, keyed by chat:message. The delivery sink records each
// landed reply so the 🔊 speak button can re-speak the full text of a message
// the chat may have truncated or the tap may not carry. FIFO-capped: entries
// past the limit are the oldest, and a miss just falls back to the tapped
// text (speak-button.ts).

const RECENT_REPLY_LIMIT = 256;

const recentReplies = new Map<string, string>();

function replyKey(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

export function rememberReply(chatId: number, messageId: number, text: string): void {
	recentReplies.set(replyKey(chatId, messageId), text);
	while (recentReplies.size > RECENT_REPLY_LIMIT) {
		const oldest = recentReplies.keys().next().value;
		if (oldest === undefined) break;
		recentReplies.delete(oldest);
	}
}

export function recentReplyText(chatId: number, messageId: number): string | null {
	return recentReplies.get(replyKey(chatId, messageId)) ?? null;
}
