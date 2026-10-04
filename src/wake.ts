// Wake — submit a system-generated user message into a pinned
// conversation address through the ordinary turn path: resolve the
// conversation, build a normal delivery sink, runtime.submit. This is
// the shared door program fires and delegation notices take
// (DESIGN.md, "Programs" / "Delegation") — no special execution
// path. A live turn steers the message in at its next step boundary;
// otherwise the lane queue orders it into a fresh turn. Epoch
// fencing applies either way.
//
// Returns true only when the submit was admitted to a turn (not merely
// appended to history by a closed runtime). On a throw the constructed sink
// is released with the error — same contract as the intake flush: a
// constructed sink is already "typing" and would ghost forever.

import type { Conversation, ConversationAddress, ConversationStore } from "./conversation.ts";
import { paths, type ConfigRef, type TtsConfig } from "./config.ts";
import { userMessage, type Runtime } from "./runtime.ts";
import { isRollingChat, routeDm, type RollDeps } from "./rolling.ts";
import { log } from "./log.ts";
import { makeDeliverySink, type DeliveryApi } from "./tg/delivery.ts";
import { sendRollMarker } from "./tg/notify.ts";

export interface WakeDeps {
	store: ConversationStore;
	runtime: Runtime;
	api: DeliveryApi;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
	// Rolling DM wiring — a fire into a private chat routes through the
	// roller like a message would (design/telegram.md → Rolling DM).
	roll: RollDeps;
}

export interface WakeAddress {
	chatId: number;
	threadId: number | null;
}

export function wake(
	deps: WakeDeps,
	address: WakeAddress,
	text: string,
	opts?: { dmTrigger?: "fire" | "current" },
): boolean {
	let conv: Conversation;
	if (address.threadId === null && isRollingChat(address.chatId)) {
		// Rolling DM: the fire rolls or joins by the same rules intake
		// uses — past the gap it rolls, inside it it joins. dmTrigger
		// "current" pins the join: delegation notices carry an
		// assistant-generated event into the live conversation, not a
		// fresh subject, so they never roll. The marker is issued
		// before the submit but not awaited: wake stays synchronous
		// and a send failure warns inside sendRollMarker, never blocks
		// the turn.
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
