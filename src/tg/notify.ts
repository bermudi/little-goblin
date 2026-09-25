// Outage notices — the one sanctioned proactive message from background
// machinery to the operator (DESIGN.md, Slice 2 ruling 5 amendment).
// Parses a conversation id back into its Telegram address (the inverse
// of conversation.ts's addressId) and sends plain text there. This is a
// grammy-aware module by design: domain code hands over ids, never
// context objects.
import type { Api } from "grammy";
import { log } from "../log.ts";

export function parseConversationAddress(
	id: string,
): { chatId: number; threadId: number | null } | null {
	const dm = /^dm:(-?\d+)$/.exec(id);
	if (dm) return { chatId: Number(dm[1]), threadId: null };
	const topic = /^topic:(-?\d+):(\d+)$/.exec(id);
	if (topic) return { chatId: Number(topic[1]), threadId: Number(topic[2]) };
	return null;
}

// Throws on delivery failure — the outage tracker retries on the next
// worker failure, so the error must propagate, never log-and-swallow.
export async function sendMemoryOutageNotice(
	api: Api,
	conversationId: string,
	sinceMs: number,
	queued: number,
): Promise<void> {
	const addr = parseConversationAddress(conversationId);
	if (!addr) throw new Error(`unparseable conversation id: ${conversationId}`);
	const hours = Math.max(1, Math.round(sinceMs / 3_600_000));
	const text =
		`⚠️ memory service has been unreachable for ~${hours}h — ` +
		`${queued} exchange${queued === 1 ? "" : "s"} queued locally, nothing lost. ` +
		"/memory status for detail.";
	await api.sendMessage(
		addr.chatId,
		text,
		addr.threadId !== null ? { message_thread_id: addr.threadId } : {},
	);
	log.info("memory outage notice sent", { conversation: conversationId, hours, queued });
}
