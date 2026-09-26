// Wake — submit a system-generated user message into a pinned
// conversation address through the ordinary turn path: resolve the
// conversation, build a normal delivery sink, runtime.submit. This is
// the shared door program fires and delegation notices take
// (DESIGN.md, "Programs" / "Delegation") — no special execution
// path, the lane queue orders it behind any live turn, epoch fencing
// applies.
//
// Returns true when the submit landed. On a throw the constructed sink
// is released with the error — same contract as the intake flush: a
// constructed sink is already "typing" and would ghost forever.

import type { Api } from "grammy";
import type { ConversationAddress, ConversationStore } from "./conversation.ts";
import { paths, type ConfigRef, type TtsConfig } from "./config.ts";
import { userMessage, type Runtime } from "./runtime.ts";
import { log } from "./log.ts";
import { makeDeliverySink } from "./tg/delivery.ts";

export interface WakeDeps {
	store: ConversationStore;
	runtime: Runtime;
	api: Api;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
}

export interface WakeAddress {
	chatId: number;
	threadId: number | null;
}

export function wake(deps: WakeDeps, address: WakeAddress, text: string): boolean {
	const addr: ConversationAddress =
		address.threadId === null
			? { kind: "dm", chatId: address.chatId }
			: { kind: "topic", chatId: address.chatId, threadId: address.threadId };
	const conv = deps.store.resolve(addr, paths.workspace());
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
		deps.runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
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
