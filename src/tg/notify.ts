// Outage notices — the one sanctioned proactive message from background
// machinery to the operator (DESIGN.md, Slice 2 ruling 5 amendment).
// Parses a conversation id back into its Telegram address (the inverse
// of conversation.ts's formatAddress) and sends plain text there. This is a
// grammy-aware module by design: domain code hands over ids, never
// context objects.
import type { Api } from "grammy";
import { channelOf, parseAddress } from "../conversation.ts";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";

export function parseConversationAddress(
	id: string,
): { chatId: number; threadId: number | null } | null {
	// dm:<chat> and dm:<chat>:<n> decode to the bare chat — a rolling
	// conversation's door is the private chat itself, never a thread
	// (Rolling DM). Guest and app ids are not telegram doors.
	const parsed = parseAddress(id);
	if (parsed === null) return null;
	if (parsed.kind === "dm" || parsed.kind === "rolling") {
		return { chatId: parsed.chatId, threadId: null };
	}
	if (parsed.kind === "topic") return { chatId: parsed.chatId, threadId: parsed.threadId };
	return null;
}

// Rolling DM boundary marker (design/telegram.md → Rolling DM): a plain
// message in the chat, never a thread — delivery, not history, so it
// never lands in store.append. Failure warns and never blocks the
// turn: the `dm rolled` log line is the record, the marker is a nicety.
const ROLL_MARKER = "— new conversation —";

export async function sendRollMarker(
	api: Api,
	chatId: number,
	toConversation: string,
): Promise<void> {
	try {
		await withTimeout(api.sendMessage(chatId, ROLL_MARKER), "sendMessage (roll marker)");
	} catch (err) {
		// Abandoned, not cancelled — the marker may still have landed;
		// either way it never blocks the turn.
		if (err instanceof TelegramTimeoutError) {
			log.warn("dm roll marker delivery uncertain — send timed out", {
				chat: chatId,
				conversation: toConversation,
				label: err.label,
			});
			return;
		}
		log.warn("dm roll marker send failed", err, {
			chat: chatId,
			conversation: toConversation,
		});
	}
}

// The door each notice needs. An app conversation is a deliberate skip,
// not a parse failure — app conversations ring nothing (DESIGN.md, App
// channel: no push), and their own history stays the durable record.
function noticeDoor(
	conversationId: string,
): { chatId: number; threadId: number | null } | "app" | "guest" | null {
	if (channelOf(conversationId) === "app") return "app";
	// Guest conversations never queue memory or reviews (off the record
	// by construction), so no notice source should name one — but if a
	// future path does, skip rather than send operator-facing text into
	// a third-party chat (or throw into a retry loop).
	if (channelOf(conversationId) === "guest") return "guest";
	return parseConversationAddress(conversationId);
}

// Throws on delivery failure — the outage tracker retries on the next
// worker failure, so the error must propagate, never log-and-swallow.
export async function sendMemoryOutageNotice(
	api: Api,
	conversationId: string,
	sinceMs: number,
	queued: number,
): Promise<void> {
	const addr = noticeDoor(conversationId);
	if (addr === "app" || addr === "guest") {
		log.info("memory outage notice skipped — app conversation rings nothing", {
			conversation: conversationId,
			queued,
		});
		return;
	}
	if (!addr) throw new Error(`unparseable conversation id: ${conversationId}`);
	const hours = Math.max(1, Math.round(sinceMs / 3_600_000));
	const text =
		`⚠️ memory service has been unreachable for ~${hours}h — ` +
		`${queued} exchange${queued === 1 ? "" : "s"} queued locally, nothing lost. ` +
		"/memory status for detail.";
	await withTimeout(
		api.sendMessage(
			addr.chatId,
			text,
			addr.threadId !== null ? { message_thread_id: addr.threadId } : {},
		),
		"sendMessage (memory outage notice)",
	);
	log.info("memory outage notice sent", { conversation: conversationId, hours, queued });
}

// Same discipline as the outage notice, for the other silent failure the
// 2026-09-25 incident exposed: a retention document stuck `blocked` in
// the outbox. One line, plain text, into the conversation whose exchange
// is stuck. Sent at most once per document (the queue's noteBlocked
// latch); throws on delivery failure — the caller fire-and-forgets and
// logs, /memory status stays the durable surface.
export async function sendMemoryBlockedNotice(
	api: Api,
	conversationId: string,
	error: string | null,
	attempts: number,
): Promise<void> {
	const addr = noticeDoor(conversationId);
	if (addr === "app" || addr === "guest") {
		log.info("memory blocked notice skipped — app conversation rings nothing", {
			conversation: conversationId,
			attempts,
		});
		return;
	}
	if (!addr) throw new Error(`unparseable conversation id: ${conversationId}`);
	const text =
		`memory retention blocked for one exchange: ${(error ?? "unknown error").slice(0, 120)} — ` +
		"/memory retry to resend, /memory dismiss to drop";
	await withTimeout(
		api.sendMessage(
			addr.chatId,
			text,
			addr.threadId !== null ? { message_thread_id: addr.threadId } : {},
		),
		"sendMessage (memory blocked notice)",
	);
	log.info("memory blocked notice sent", { conversation: conversationId, attempts });
}

// The skill reviewer's write notice (DESIGN.md, "Skill reviewer") — the
// second sanctioned proactive message: a saved skill announces itself
// in the topic it was learned in. Throws on delivery failure like the
// notices above — the reviewer logs it, and the history event it already
// wrote stays the durable record.
export async function sendSkillSavedNotice(
	api: Api,
	conversationId: string,
	skills: string[],
): Promise<void> {
	const addr = noticeDoor(conversationId);
	if (addr === "app" || addr === "guest") {
		log.info("skill saved notice skipped — app conversation rings nothing", {
			conversation: conversationId,
			skills,
		});
		return;
	}
	if (!addr) throw new Error(`unparseable conversation id: ${conversationId}`);
	const names = skills.length === 1 ? `skill: ${skills[0]}` : `skills: ${skills.join(", ")}`;
	await withTimeout(
		api.sendMessage(
			addr.chatId,
			`saved ${names} — reply to undo`,
			addr.threadId !== null ? { message_thread_id: addr.threadId } : {},
		),
		"sendMessage (skill saved notice)",
	);
	log.info("skill saved notice sent", { conversation: conversationId, skills });
}
