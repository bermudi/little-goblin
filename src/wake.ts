// Wakes use ordinary turn submission so queued and live turns share ordering
// and epoch fencing. A constructed sink must be released if submission throws.

import type { Conversation, ConversationAddress, ConversationStore } from "./conversation.ts";
import { paths, type ConfigRef, type TtsConfig } from "./config.ts";
import type { JevClient } from "./jev.ts";
import { userMessage, type Runtime, type TurnSink } from "./runtime.ts";
import { isRollingChat, routeDm, type RollDeps } from "./rolling.ts";
import { log } from "./log.ts";
import { makeBellSink, type BellDeps } from "./tg/bell.ts";
import { makeDeliverySink, type DeliveryApi } from "./tg/delivery.ts";
import { sendRollMarker } from "./tg/notify.ts";
import type { PingStore } from "./tg/pings.ts";

export interface WakeDeps {
	store: ConversationStore;
	runtime: Runtime;
	api: DeliveryApi;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
	// Wakes use synchronous routeDm: it honors the live gap but skips intake's follow-up check.
	roll: RollDeps;
	// App turns need a headless sink; they have no Telegram delivery address.
	bell(conv: Conversation): TurnSink;
}

export interface WakeAddress {
	chatId: number;
	threadId: number | null;
}

/** Composition supplies these dependencies; this module owns fire routing. */
export interface WakeBase {
	store: ConversationStore;
	runtime: Runtime;
	api: DeliveryApi;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
	// wake() uses routeDm, which does not consult this intake-only gate.
	followUpGate(): Pick<JevClient, "decide"> | undefined;
	// Lets swipe replies to delegation rings reach the app conversation.
	pings: PingStore;
}

// Resolve live gap settings for rolling DMs and provide a bell sink for app turns.
export function makeWakeDeps(base: WakeBase): WakeDeps {
	const bell: BellDeps = {
		api: base.api,
		store: base.store,
		pings: base.pings,
		allowedUsers: () => base.configRef.current.allowedUsers,
		publicUrl: () => base.configRef.current.publicUrl || undefined,
	};
	return {
		store: base.store,
		runtime: base.runtime,
		api: base.api,
		configRef: base.configRef,
		synthesize: base.synthesize,
		roll: {
			store: base.store,
			runtime: base.runtime,
			gapMinutes: () => base.configRef.current.telegram.dmGapMinutes,
			gate: base.followUpGate,
		},
		bell: (conv: Conversation): TurnSink => makeBellSink(bell, conv, "delegation notice"),
	};
}

// A rejected or failed submit returns false so delegation notices can retry.
export function wake(
	deps: WakeDeps,
	address: WakeAddress,
	text: string,
	opts?: { dmTrigger?: "fire" | "current" },
): boolean {
	let conv: Conversation;
	if (address.threadId === null && isRollingChat(address.chatId)) {
		// "current" joins the live DM; "fire" applies normal gap rolling.
		// Mark before submit without awaiting: wake stays synchronous, and
		// sendRollMarker logs delivery failures without blocking the turn.
		const routed = routeDm(deps.roll, address.chatId, opts?.dmTrigger ?? "fire");
		if (routed.rolled) void sendRollMarker(deps.api, address.chatId, routed.conv.id);
		conv = routed.conv;
	} else {
		const addr: ConversationAddress =
			address.threadId === null
				? { kind: "dm", chatId: address.chatId }
				: { kind: "topic", chatId: address.chatId, threadId: address.threadId };
		conv = deps.store.resolve(addr, paths.workspace());
	}
	const tts = deps.configRef.current.tts;
	const sink = makeDeliverySink(
		deps.api,
		conv,
		undefined,
		undefined,
		tts && !deps.configRef.ttsDown
			? { voiceMode: conv.voice, synthesize: (t) => deps.synthesize(t, tts) }
			: undefined,
	);
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
