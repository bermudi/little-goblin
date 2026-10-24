// Turn input shared by ordinary intake and the /skill door (ruling
// 2026-10-21): the shared-chat audience note that prefixes durable
// user messages in group lanes, and the conversation-configured
// delivery sink that decides how a turn's output reaches Telegram.
// Both doors must produce identical annotations and identical sink
// behavior — a /skill turn is indistinguishable from a typed one.

import type { Api } from "grammy";
import type { ConfigRef, TtsConfig } from "../config.ts";
import {
	channelOf,
	type Conversation,
	type ConversationStore,
} from "../conversation.ts";
import { makeDeliverySink } from "./delivery.ts";
import type { TurnSink } from "../runtime.ts";

export const SHARED_CHAT_NOTE =
	"[note: this is a shared chat — everyone in it can read your replies. " +
	"Be deliberate before surfacing private material (workspace files, notes, past conversations).]";

export function sharedChatPart(
	conversationId: string,
	chatId: number,
): { type: "text"; text: string } | null {
	if (channelOf(conversationId) === "guest") return null;
	if (chatId >= 0) return null;
	return { type: "text", text: SHARED_CHAT_NOTE };
}

// Structural deps — the bot's BotDeps satisfies this without a circular
// import back into mod.ts.
export interface ConversationSinkDeps {
	configRef: ConfigRef;
	store: Pick<ConversationStore, "lastReplyAnchor">;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
}

// The sink a turn gets in this conversation: voice mode when TTS is
// configured, up, and the conversation wants it; rating rows; rich
// drafts per config. replyTo anchors the first reply chunk to the
// operator's message when intake carried one.
export function makeConversationDeliverySink(
	api: Api,
	conv: Conversation,
	deps: ConversationSinkDeps,
	replyTo?: number,
): TurnSink {
	const tts = deps.configRef.current.tts;
	return makeDeliverySink(api, conv, {
		...(replyTo !== undefined ? { replyTo } : {}),
		...(tts && !deps.configRef.ttsDown
			? {
					voice: {
						voiceMode: conv.voice,
						synthesize: (text: string) => deps.synthesize(text, tts),
					},
				}
			: {}),
		rating: deps.store,
		rich: {
			enabled: deps.configRef.current.telegram.richReplies,
			reasoning: deps.configRef.current.telegram.showReasoning,
		},
	});
}
