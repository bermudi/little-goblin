// Wakes use ordinary turn submission so queued and live turns share ordering
// and epoch fencing. A constructed sink must be released if submission throws.

import type { Conversation } from "./conversation-read.ts";
import type { ConversationStore } from "./conversation.ts";
import { channelOf } from "./conversation-address.ts";
import type { ConversationAddress } from "./conversation-address.ts";
import { paths } from "./home-layout.ts";
import { userMessage, type Runtime } from "./runtime.ts";
import type { TurnSink } from "./turn/sink.ts";
import { isRollingChat, routeDm, type RollDeps } from "./rolling.ts";
import { appConversationOf, telegramAddressOf, type ConversationTarget } from "./targets.ts";
import { log } from "./log.ts";

export interface WakeDeps {
	store: ConversationStore;
	runtime: Runtime;
	// Telegram delivery exists only while that channel is enabled. Its
	// absence is a refused wake, never a turn without an output door.
	delivery?(conv: Conversation): TurnSink;
	markRoll?(chatId: number, conversationId: string): Promise<void>;
	// Wakes use synchronous routeDm: it honors the live gap but skips intake's follow-up check.
	roll: RollDeps;
	// App turns need a headless sink; they have no Telegram delivery address.
	bell(conv: Conversation): TurnSink;
}

export interface WakeAddress {
	chatId: number;
	threadId: number | null;
}

// One owner for the app/telegram sink route: app conversations always
// take the bell; telegram and guest conversations take delivery when the
// channel is attached, else fall back to the bell (durable wakes).
export function sinkFor(
	deps: Pick<WakeDeps, "bell" | "delivery">,
	conv: Conversation,
): TurnSink {
	if (channelOf(conv.id) === "app") return deps.bell(conv);
	if (deps.delivery !== undefined) return deps.delivery(conv);
	return deps.bell(conv);
}

// A rejected or failed submit returns false so delegation notices can retry.
export function wake(
	deps: WakeDeps,
	address: WakeAddress,
	text: string,
	opts?: { dmTrigger?: "fire" | "current" },
): boolean {
	const delivery = deps.delivery;
	if (delivery === undefined) {
		log.warn("telegram wake refused — channel disabled", { address });
		return false;
	}
	if (!deps.runtime.accepting()) return false;
	let conv: Conversation;
	if (address.threadId === null && isRollingChat(address.chatId)) {
		// "current" joins the live DM; "fire" applies normal gap rolling.
		// Mark before submit without awaiting: wake stays synchronous, and
		// the Telegram adapter logs marker failures without blocking the turn.
		const routed = routeDm(deps.roll, address.chatId, opts?.dmTrigger ?? "fire");
		if (routed.rolled && deps.markRoll !== undefined) {
			void deps.markRoll(address.chatId, routed.conv.id);
		}
		conv = routed.conv;
	} else {
		const addr: ConversationAddress =
			address.threadId === null
				? { kind: "dm", chatId: address.chatId }
				: { kind: "topic", chatId: address.chatId, threadId: address.threadId };
		conv = deps.store.resolve(addr, paths.workspace());
	}
	const sink = delivery(conv);
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
	const destination = deps.store.appRollDestination(conversationId);
	if (destination !== conversationId) {
		log.info("app wake retargeted to the newest roll", { from: conversationId, to: destination });
	}
	const conv = deps.store.get(destination);
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

// Canonical program targets route by channel: Telegram addresses keep
// the rolling-DM rules; app targets go through wakeApp.
export function wakeTarget(deps: WakeDeps, target: ConversationTarget, text: string): boolean {
	const telegram = telegramAddressOf(target);
	if (telegram !== null) return wake(deps, telegram, text);
	const appConversation = appConversationOf(target);
	if (appConversation !== null) return wakeApp(deps, appConversation, text);
	log.error("program wake dropped — invalid target", { target });
	return false;
}
