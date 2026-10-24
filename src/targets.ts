// Channel destinations are canonical conversation addresses, not
// transport coordinates. A Telegram target is its durable address (the
// rolling DM pins dm:<chat>, never one concrete row); an app target is
// the conversation id it replies into.

import {
	appIdOf,
	channelOf,
	formatAddress,
	parseAddress,
	type Conversation,
} from "./conversation.ts";

export type ConversationTarget = string;
export type DecisionActor = string;
export const APP_ACTOR: DecisionActor = "app";
export const telegramActor = (userId: number): DecisionActor => `telegram:${userId}`;

export function telegramTarget(chatId: number, threadId: number | null): ConversationTarget {
	return formatAddress(
		threadId === null ? { kind: "dm", chatId } : { kind: "topic", chatId, threadId },
	);
}

export function targetOf(conv: Conversation): ConversationTarget {
	if (channelOf(conv.id) === "app") return conv.id;
	if (conv.threadId === null) return formatAddress({ kind: "dm", chatId: conv.chatId });
	return formatAddress({ kind: "topic", chatId: conv.chatId, threadId: conv.threadId });
}

export function telegramAddressOf(target: ConversationTarget): {
	chatId: number;
	threadId: number | null;
} | null {
	const parsed = parseAddress(target);
	if (parsed?.kind === "dm") return { chatId: parsed.chatId, threadId: null };
	if (parsed?.kind === "topic") return { chatId: parsed.chatId, threadId: parsed.threadId };
	return null;
}

export function appConversationOf(target: ConversationTarget): string | null {
	return appIdOf(target) === null ? null : target;
}

export function validTarget(target: unknown): target is ConversationTarget {
	if (typeof target !== "string") return false;
	const parsed = parseAddress(target);
	return parsed?.kind === "app" || parsed?.kind === "dm" || parsed?.kind === "topic" ? true : false;
}

/** The pseudo-address of a responsibility-destination program row — not a
 *  conversation, but a canonical non-empty string for the programs
 *  table's NOT NULL target column. Every conversation projection
 *  (telegramAddressOf, appConversationOf) yields null for it, and
 *  delivery branches on responsibilityId before ever reading it. */
export function responsibilityTarget(responsibilityId: string): ConversationTarget {
	return `resp:${responsibilityId}`;
}

export function responsibilityTargetOf(target: ConversationTarget): string | null {
	return target.startsWith("resp:") ? target.slice("resp:".length) : null;
}
