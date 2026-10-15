// Wakes use ordinary turn submission so queued and live turns share ordering
// and epoch fencing. A constructed sink must be released if submission throws.

import {
	channelOf,
	type Conversation,
	type ConversationAddress,
	type ConversationStore,
} from "./conversation.ts";
import { paths } from "./config.ts";
import { userMessage, type Runtime, type TurnSink } from "./runtime.ts";
import { isRollingChat, routeDm, type RollDeps } from "./rolling.ts";
import { log } from "./log.ts";

export interface WakeDeps {
	store: ConversationStore;
	runtime: Runtime;
	delivery(conv: Conversation): TurnSink;
	markRoll(chatId: number, conversationId: string): Promise<void>;
	// Wakes use synchronous routeDm: it honors the live gap but skips intake's follow-up check.
	roll: RollDeps;
	// App turns need a headless sink; they have no Telegram delivery address.
	bell(conv: Conversation): TurnSink;
}

export interface WakeAddress {
	chatId: number;
	threadId: number | null;
}

// A rejected or failed submit returns false so delegation notices can retry.
export function wake(
	deps: WakeDeps,
	address: WakeAddress,
	text: string,
	opts?: { dmTrigger?: "fire" | "current" },
): boolean {
	if (!deps.runtime.accepting()) return false;
	let conv: Conversation;
	if (address.threadId === null && isRollingChat(address.chatId)) {
		// "current" joins the live DM; "fire" applies normal gap rolling.
		// Mark before submit without awaiting: wake stays synchronous, and
		// the Telegram adapter logs marker failures without blocking the turn.
		const routed = routeDm(deps.roll, address.chatId, opts?.dmTrigger ?? "fire");
		if (routed.rolled) void deps.markRoll(address.chatId, routed.conv.id);
		conv = routed.conv;
	} else {
		const addr: ConversationAddress =
			address.threadId === null
				? { kind: "dm", chatId: address.chatId }
				: { kind: "topic", chatId: address.chatId, threadId: address.threadId };
		conv = deps.store.resolve(addr, paths.workspace());
	}
	const sink = deps.delivery(conv);
	try {
		const admitted = deps.runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
		if (!admitted) {
			log.warn("wake history only — runtime closed", { conversation: conv.id });
			return false;
		}
	} catch (err) {
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
		log.error("wake submit failed", err, { conversation: conv.id });
		return false;
	}
	return true;
}

// The bell fires when the queued turn lands, not at submission. A rejected
// or failed submit stays retryable; a deleted row is the intentional drop.
export function wakeApp(deps: WakeDeps, conversationId: string, text: string): boolean {
	if (!deps.runtime.accepting()) return false;
	const conv = deps.store.get(conversationId);
	if (conv === null) {
		log.warn("delegation notice dropped — app conversation deleted", {
			conversation: conversationId,
		});
		return true;
	}
	const sink = deps.bell(conv);
	try {
		const admitted = deps.runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
		if (!admitted) {
			log.warn("app wake history only — runtime closed", { conversation: conv.id });
			return false;
		}
	} catch (err) {
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
		log.error("app wake submit failed", err, { conversation: conv.id });
		return false;
	}
	return true;
}

// Subagent notices route to the EXACT stored origin row — never a rolled
// DM, never a new conversation. App origins ring the bell; telegram and
// guest origins deliver to the row's recorded chat/thread. A deleted
// origin is the intentional drop; a rejected submit returns false so the
// owner retries on scan.
export function wakeConversation(deps: WakeDeps, conversationId: string, text: string): boolean {
	if (!deps.runtime.accepting()) return false;
	const conv = deps.store.get(conversationId);
	if (conv === null) {
		log.warn("subagent notice dropped — origin conversation deleted", {
			conversation: conversationId,
		});
		return true;
	}
	const channel = channelOf(conv.id);
	const sink = channel === "app" ? deps.bell(conv) : deps.delivery(conv);
	try {
		const admitted = deps.runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
		if (!admitted) {
			log.warn("subagent wake history only — runtime closed", { conversation: conv.id });
			return false;
		}
	} catch (err) {
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
		log.error("subagent wake submit failed", err, { conversation: conv.id });
		return false;
	}
	return true;
}
