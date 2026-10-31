import type { Api } from "grammy";
import { channelOf, parseAddress } from "../conversation.ts";
import { log } from "../log.ts";
import { proposalFingerprint } from "../skill-decisions.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import { skillDiscardData, skillInstallData } from "./skill-approval.ts";

export function parseConversationAddress(
	id: string,
): { chatId: number; threadId: number | null } | null {
	const parsed = parseAddress(id);
	if (parsed === null) return null;
	if (parsed.kind === "dm" || parsed.kind === "rolling") {
		return { chatId: parsed.chatId, threadId: null };
	}
	if (parsed.kind === "topic") return { chatId: parsed.chatId, threadId: parsed.threadId };
	return null;
}

const ROLL_MARKER = "— new conversation —";

export async function sendRollMarker(
	api: Api,
	chatId: number,
	toConversation: string,
): Promise<void> {
	try {
		await withTimeout(
			api.sendMessage(chatId, ROLL_MARKER, { disable_notification: true }),
			"sendMessage (roll marker)",
		);
	} catch (err) {
		if (err instanceof TelegramTimeoutError) {
			// A timeout abandons the send, it does not cancel it (deadline.ts):
			// the marker may land late, after the answer it was meant to
			// precede. Resending could duplicate it and throwing would break
			// the fire-and-forget callers (wake.ts voids markRoll; intake
			// awaits this before admission), so the honest surface is this
			// error line carrying the marker text for the operator to spot.
			log.error("dm roll marker delivery uncertain — send timed out, may land late", err, {
				chat: chatId,
				conversation: toConversation,
				label: err.label,
				marker: ROLL_MARKER,
			});
			return;
		}
		log.warn("dm roll marker send failed", err, {
			chat: chatId,
			conversation: toConversation,
		});
	}
}

function noticeDoor(
	conversationId: string,
): { chatId: number; threadId: number | null } | "app" | "guest" | null {
	if (channelOf(conversationId) === "app") return "app";
	if (channelOf(conversationId) === "guest") return "guest";
	return parseConversationAddress(conversationId);
}

export async function sendMemoryOutageNotice(
	api: Api | null,
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
	if (api === null) {
		log.warn("memory outage notice skipped — telegram channel unavailable", {
			conversation: conversationId,
			queued,
		});
		return;
	}
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

export async function sendMemoryBlockedNotice(
	api: Api | null,
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
	if (api === null) {
		log.warn("memory blocked notice skipped — telegram channel unavailable", {
			conversation: conversationId,
			attempts,
		});
		return;
	}
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

export async function sendSkillProposedNotice(
	api: Api | null,
	conversationId: string,
	skills: string[],
	proposedDir?: string,
): Promise<void> {
	const addr = noticeDoor(conversationId);
	if (addr === "app" || addr === "guest") {
		log.info("skill proposal notice skipped — app conversation rings nothing", {
			conversation: conversationId,
			skills,
		});
		return;
	}
	if (!addr) throw new Error(`unparseable conversation id: ${conversationId}`);
	if (api === null) {
		log.warn("skill proposal notice skipped — telegram channel unavailable", {
			conversation: conversationId,
			skills,
		});
		return;
	}
	const thread = addr.threadId !== null ? { message_thread_id: addr.threadId } : {};
	const sent: string[] = [];
	for (const skill of skills) {
		// Buttons bind to the proposal's content fingerprint: a tap on a
		// since-changed proposal is refused at the door. No fingerprintable
		// proposal (or callback data over Telegram's 64-byte cap) degrades
		// to the conversational notice — never an unbound button.
		const fingerprint = proposedDir === undefined ? null : proposalFingerprint(proposedDir, skill);
		const installData =
			fingerprint === null ? null : skillInstallData(conversationId, skill, fingerprint);
		const discardData =
			fingerprint === null ? null : skillDiscardData(conversationId, skill, fingerprint);
		const buttonsRide =
			installData !== null &&
			discardData !== null &&
			installData.length <= 64 &&
			discardData.length <= 64;
		if (!buttonsRide) {
			log.info("skill proposal notice — no tappable buttons; conversational only", {
				conversation: conversationId,
				skill,
				reason:
					fingerprint === null ? "no fingerprintable proposal" : "callback data over 64 bytes",
			});
		}
		try {
			await withTimeout(
				api.sendMessage(addr.chatId, `proposed skill: ${skill} — approve to install`, {
					...thread,
					...(buttonsRide && installData !== null && discardData !== null
						? {
								reply_markup: {
									inline_keyboard: [
										[
											{ text: "✅ Install", callback_data: installData },
											{ text: "🚫 Discard", callback_data: discardData },
										],
									],
								},
							}
						: {}),
				}),
				"sendMessage (skill proposal notice)",
			);
			sent.push(skill);
		} catch (err) {
			// One undeliverable skill must not abort the rest of the batch.
			log.error("skill proposal notice failed for one skill", err, {
				conversation: conversationId,
				skill,
			});
		}
	}
	log.info("skill proposal notice sent", { conversation: conversationId, skills: sent });
}
