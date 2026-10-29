// Conversation identity: a conversation IS its channel address
// (DESIGN.md -> Domain model). Pure parsing/formatting — no store,
// no I/O. Malformed addresses fail here, never downstream.

import { z } from "zod";

// Routing discriminates on kind alone; the app member's zeros are fillers,
// not real coordinates.
export type ConversationAddress =
	| { kind: "dm"; chatId: number }
	| { kind: "topic"; chatId: number; threadId: number }
	// chatId is the summoned chat (negative for groups), userId the summoner.
	| { kind: "guest"; chatId: number; userId: number }
	| { kind: "app"; appId: string; chatId: 0; threadId: 0 };

export const APP_ID_PREFIX = "app/";

// Client-minted, but the id rides an HTTP path segment — must stay url-safe
// and slash-free.
export const appIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "app ids are [A-Za-z0-9_-], 1-64 chars");

// n is a creation ordinal that only grows; resolve() must never mint one.
export interface RollingDmAddress {
	kind: "rolling";
	chatId: number;
	ordinal: number;
}

export type ParsedAddress = ConversationAddress | RollingDmAddress;

// Malformed addresses fail here, not silently downstream.
export function formatAddress(addr: ParsedAddress): string {
	if (addr.kind === "dm") return `dm:${addr.chatId}`;
	if (addr.kind === "rolling") return `dm:${addr.chatId}:${addr.ordinal}`;
	if (addr.kind === "topic") return `topic:${addr.chatId}:${addr.threadId}`;
	if (addr.kind === "guest") return `guest:${addr.chatId}:${addr.userId}`;
	return `${APP_ID_PREFIX}${appIdSchema.parse(addr.appId)}`;
}

const dmIdRe = /^dm:(-?\d+)$/;
const rollingDmIdRe = /^dm:(-?\d+):([1-9]\d*)$/;
const topicIdRe = /^topic:(-?\d+):(-?\d+)$/;
const guestIdRe = /^guest:(-?\d+):(-?\d+)$/;

function coordsOf(match: RegExpExecArray | null): number[] | null {
	if (match === null) return null;
	const nums = match.slice(1).map(Number);
	return nums.every(Number.isSafeInteger) ? nums : null;
}

// parseAddress ∘ formatAddress is the identity on every id; null on anything
// else — callers route on the null, never guess. Rolling ordinals decode as
// [1-9]\d*: rollDm mints them and never rewrites them, so a zero or
// leading-zero ordinal is not an id.
export function parseAddress(id: string): ParsedAddress | null {
	if (id.startsWith(APP_ID_PREFIX)) {
		const appId = appIdSchema.safeParse(id.slice(APP_ID_PREFIX.length));
		return appId.success ? { kind: "app", appId: appId.data, chatId: 0, threadId: 0 } : null;
	}
	const rolling = coordsOf(rollingDmIdRe.exec(id));
	if (rolling !== null) return { kind: "rolling", chatId: rolling[0]!, ordinal: rolling[1]! };
	const dm = coordsOf(dmIdRe.exec(id));
	if (dm !== null) return { kind: "dm", chatId: dm[0]! };
	const topic = coordsOf(topicIdRe.exec(id));
	if (topic !== null) return { kind: "topic", chatId: topic[0]!, threadId: topic[1]! };
	const guest = coordsOf(guestIdRe.exec(id));
	if (guest !== null) return { kind: "guest", chatId: guest[0]!, userId: guest[1]! };
	return null;
}

export function appIdOf(conversationId: string): string | null {
	const parsed = parseAddress(conversationId);
	return parsed !== null && parsed.kind === "app" ? parsed.appId : null;
}

export function appAddress(appId: string): ConversationAddress {
	return { kind: "app", appId: appIdSchema.parse(appId), chatId: 0, threadId: 0 };
}

// The id prefix is the whole discriminant. "guest" is its own channel, not
// a telegram flavor — tool assembly and delivery branch on it.
export function channelOf(conversationId: string): "telegram" | "app" | "guest" {
	if (conversationId.startsWith(APP_ID_PREFIX)) return "app";
	if (conversationId.startsWith("guest:")) return "guest";
	return "telegram";
}

export function guestAddress(chatId: number, userId: number): ConversationAddress {
	return { kind: "guest", chatId, userId };
}

const privateChatIdSchema = z.number().int().positive();

// Only canonical rolling private DM identities can enter a back chain.
// Checking coordinates too prevents a malformed disk link crossing pools.
export function rollingDmOrdinal(
	row: { id: string; chat_id: number; thread_id: number | null },
	chatId: number,
): number | null {
	const parsed = parseAddress(row.id);
	return parsed !== null &&
		parsed.kind === "rolling" &&
		parsed.chatId === chatId &&
		row.chat_id === chatId &&
		row.thread_id === null
		? parsed.ordinal
		: null;
}

export function isPrivateChatId(chatId: number): boolean {
	return privateChatIdSchema.safeParse(chatId).success;
}

export { privateChatIdSchema };
