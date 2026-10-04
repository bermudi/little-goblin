// The bell — the headless sink for app-channel background turns
// nobody is streaming (design/app.md → Spin-off → Background turns /
// Telegram rings). The turn persists like a client-driven one; when
// it lands, each allowed operator gets a DM ping with the deep link,
// the ping is journaled into their current DM conversation (so "what
// was that about?" is answerable and counts as gap activity), and the
// ping→conversation mapping is recorded so a swipe-reply routes back.
//
// A delivery sink it is not: no streaming, no typing indicator, no
// voice or file doors — Telegram only ever sees the one summary
// message per finished turn. Every per-chat failure is logged and
// contained: a wedged send must never escape onDone into the runtime.

import { randomUUID } from "node:crypto";
import { appLink } from "../app-link.ts";
import { APP_ID_PREFIX, type Conversation, type ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { TurnSink } from "../runtime.ts";
import type { DeliveryApi } from "./delivery.ts";
import type { PingStore } from "./pings.ts";

export interface BellDeps {
	api: DeliveryApi;
	store: ConversationStore;
	pings: PingStore;
	/** Live reads — the mini app can change either between turns. */
	allowedUsers(): number[];
	publicUrl(): string | undefined;
}

const HEAD_LIMIT = 200;
const ERROR_HEAD_LIMIT = 120;

function headCut(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function makeBellSink(
	deps: BellDeps,
	conv: Conversation,
	trigger = "background turn",
): TurnSink {
	const appId = conv.id.slice(APP_ID_PREFIX.length);
	let text = "";
	return {
		onTextDelta(delta: string): void {
			text += delta;
		},
		onReasoningDelta(): void {},
		onToolCall(): void {},
		async onDone(done): Promise<void> {
			if (done.kind === "fenced") return;
			log.info("app background turn", {
				conversation: conv.id,
				trigger,
				outcome: done.kind,
			});
			// Re-read the title at completion — the async retitle can land
			// while the turn runs, and a deleted conversation degrades to
			// the generic label rather than a stale name.
			const title =
				deps.store.get(conv.id)?.title ?? conv.title ?? "app conversation";
			const ping =
				done.kind === "completed"
					? `${title}: ${headCut(text.replace(/\s+/g, " ").trim(), HEAD_LIMIT)}`
					: `${title}: the turn failed — ${headCut(done.message, ERROR_HEAD_LIMIT)}`;
			const publicUrl = deps.publicUrl();
			for (const chat of deps.allowedUsers()) {
				// Each chat independently — one failing operator must not
				// silence the rest, and nothing escapes onDone.
				try {
					const sent = await deps.api.sendMessage(
						chat,
						ping,
						publicUrl === undefined
							? {}
							: {
									reply_markup: {
										inline_keyboard: [
											[{ text: "Open in app", url: appLink(publicUrl, appId) }],
										],
									},
								},
					);
					deps.pings.record(chat, sent.message_id, conv.id);
					const dm = deps.store.currentDm(chat);
					if (dm === null) {
						log.debug("spin-off ping not journaled — no current DM", {
							conversation: conv.id,
							chat,
						});
					} else {
						// The ping is what the operator sees — journaled as an
						// assistant event so the DM can answer "what was that?"
						// and the quiet-gap clock sees the activity.
						deps.store.append(dm.id, [
							{
								id: randomUUID(),
								role: "assistant",
								parts: [{ type: "text", text: ping }],
							},
						]);
					}
					log.info("spin-off ping", {
						conversation: conv.id,
						chat,
						message: sent.message_id,
						outcome: done.kind,
					});
				} catch (err) {
					log.error("spin-off ping failed", err, {
						conversation: conv.id,
						chat,
					});
				}
			}
		},
	};
}
