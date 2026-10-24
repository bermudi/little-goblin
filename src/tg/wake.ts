import type { Api } from "grammy";
import { appMediaSink, composeTurnSinks } from "../app-media.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import type { ConfigRef, TtsConfig } from "../config.ts";
import type { System1Client } from "../system1.ts";
import type { Runtime, TurnSink } from "../runtime.ts";
import type { AppPush } from "../app-push.ts";
import { appPushSink } from "../app-push.ts";
import type { WakeDeps } from "../wake.ts";
import { makeBellSink, type BellDeps } from "./bell.ts";
import { makeDeliverySink } from "./delivery.ts";
import { sendRollMarker } from "./notify.ts";
import type { PingStore } from "./pings.ts";

/** Composition supplies these dependencies; this module owns fire routing. */
export interface WakeBase {
	store: ConversationStore;
	runtime: Runtime;
	/** Absent when telegram.enabled is false — app bells stay live, while
	 *  Telegram-target wakes refuse at the WakeDeps boundary. */
	api: Api | null;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
	// wake() uses routeDm, which does not consult this intake-only gate.
	followUpGate(): Pick<System1Client, "decide"> | undefined;
	// Lets swipe replies to delegation rings reach the app conversation.
	pings: PingStore;
	/** App-owned browser notification owner; absent only in tests that fake
	 *  the whole wake assembly. */
	push?: Pick<AppPush, "notifyDone">;
}

// Resolve live gap settings for rolling DMs and provide a bell sink for app turns.
export function makeWakeDeps(base: WakeBase): WakeDeps {
	const bell: BellDeps | null =
		base.api === null
			? null
			: {
					api: base.api,
					store: base.store,
					pings: base.pings,
					operators: () => base.configRef.current.operators,
					publicUrl: () => base.configRef.current.publicUrl || undefined,
				};
	return {
		store: base.store,
		runtime: base.runtime,
		...(base.api === null ? {} : makeWakeDelivery({ ...base, api: base.api })),
		roll: {
			store: base.store,
			runtime: base.runtime,
			gapMinutes: () => base.configRef.current.telegram.dmGapMinutes,
			gate: base.followUpGate,
		},
		bell: (conv: Conversation): TurnSink =>
			composeTurnSinks(
				...(bell === null ? [] : [makeBellSink(bell, conv, "delegation notice")]),
				appMediaSink(conv.id, {
					append: (messages, opts) => base.store.append(conv.id, messages, opts),
				}),
				...(base.push === undefined ? [] : [appPushSink(base.push, conv)]),
			),
	};
}

// Telegram construction stays here; the domain receives only turn sinks
// and a roll-notice port, never the client's methods or types.
export function makeWakeDelivery(base: {
	api: Api;
	store: ConversationStore;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
}): Pick<WakeDeps, "delivery" | "markRoll"> {
	return {
		markRoll: (chatId, conversationId) => sendRollMarker(base.api, chatId, conversationId),
		delivery: (conv) => {
			const tts = base.configRef.current.tts;
			return makeDeliverySink(base.api, conv, {
				...(tts && !base.configRef.ttsDown
					? {
							voice: {
								voiceMode: conv.voice,
								synthesize: (text: string) => base.synthesize(text, tts),
							},
						}
					: {}),
				rating: base.store,
				// Same rich switches as the intake path — scheduled turns land in
				// the same DM and the ruling scopes by conversation, not origin.
				rich: {
					enabled: base.configRef.current.telegram.richReplies,
					reasoning: base.configRef.current.telegram.showReasoning,
				},
			});
		},
	};
}
