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
// message per finished turn. The summary is read back out of history
// (the runtime appends the response before onDone), NOT out of this
// sink's own deltas: a bell that steered or coalesced behind another
// head never receives text deltas, so nothing it captured could be
// trusted. Every per-chat failure is logged and contained: a wedged
// send must never escape onDone into the runtime.

import { randomUUID } from "node:crypto";
import { appLink } from "../app-link.ts";
import { appIdOf, type Conversation, type ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import { messageText } from "../memory.ts";
import type { TurnSink } from "../runtime.ts";
import { API_CALL_TIMEOUT_MS, TelegramTimeoutError, withTimeout } from "./deadline.ts";
import type { DeliveryApi } from "./delivery.ts";
import type { PingStore } from "./pings.ts";

export interface BellDeps {
	api: DeliveryApi;
	store: ConversationStore;
	pings: PingStore;
	/** Live reads — the mini app can change either between turns. */
	allowedUsers(): number[];
	publicUrl(): string | undefined;
	/** Per-send ceiling — tests inject a short one. */
	timeoutMs?: number;
}

const HEAD_LIMIT = 200;
const ERROR_HEAD_LIMIT = 120;

// One ping per response, however many bells merged into its turn — a
// steered/coalesced bell sees the same newest assistant message as the
// head's, and ringing every operator twice per reply is noise. Module-
// level by necessity: the bells that merge are separate makeBellSink
// closures, so only shared state can dedup them. Bounded:
// a Set iterates in insertion order, so the front is the oldest entry.
const pingedResponses = new Set<string>();
const PINGED_CAP = 500;

function headCut(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function makeBellSink(
	deps: BellDeps,
	conv: Conversation,
	trigger = "background turn",
): TurnSink {
	const appId = appIdOf(conv.id);
	return {
		onTextDelta(): void {},
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
			// while the turn runs. A deleted conversation (get → null) degrades
			// to the generic label on the error path, never the captured stale
			// title, and its ping carries no deep link into a dead conversation.
			// (A deleted conversation's completed path never gets here: the
			// delete takes its events, so there is no stored reply to ping.)
			const live = deps.store.get(conv.id);
			const title =
				live === null ? "app conversation" : (live.title ?? conv.title ?? "app conversation");
			let ping: string;
			let pingKey: string | undefined;
			if (done.kind === "completed") {
				// The response the turn appended before onDone is the summary.
				const assistant = deps.store.history(conv.id).findLast((m) => m.role === "assistant");
				const text = assistant === undefined ? "" : messageText(assistant);
				if (assistant === undefined || text === "") {
					log.warn("spin-off ping skipped — no assistant reply", {
						conversation: conv.id,
						trigger,
					});
					return;
				}
				pingKey = `${conv.id}:${assistant.id}`;
				if (pingedResponses.has(pingKey)) {
					log.debug("spin-off ping skipped — response already pinged", {
						conversation: conv.id,
						trigger,
					});
					return;
				}
				pingedResponses.add(pingKey);
				if (pingedResponses.size > PINGED_CAP) {
					const oldest = pingedResponses.values().next().value;
					if (oldest !== undefined) pingedResponses.delete(oldest);
				}
				ping = `${title}: ${headCut(text.replace(/\s+/g, " ").trim(), HEAD_LIMIT)}`;
			} else {
				ping = `${title}: the turn failed — ${headCut(done.message, ERROR_HEAD_LIMIT)}`;
			}
			const publicUrl = deps.publicUrl();
			let delivered = false;
			for (const chat of deps.allowedUsers()) {
				// Each chat independently — one failing operator must not
				// silence the rest, and nothing escapes onDone.
				try {
					const sent = await withTimeout(
						deps.api.sendMessage(
							chat,
							ping,
							publicUrl === undefined || appId === null || live === null
								? {}
								: {
										reply_markup: {
											inline_keyboard: [[{ text: "Open in app", url: appLink(publicUrl, appId) }]],
										},
									},
						),
						"sendMessage (spin-off ping)",
						deps.timeoutMs ?? API_CALL_TIMEOUT_MS,
					);
					delivered = true;
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
					if (err instanceof TelegramTimeoutError) {
						// Abandoned, not cancelled — the send may still have
						// landed. With no message id there is nothing to
						// record or journal; a swipe-reply on it just falls
						// through to the ordinary route.
						log.warn("spin-off ping delivery uncertain — send timed out", {
							chat,
							conversation: conv.id,
							label: err.label,
						});
						continue;
					}
					log.error("spin-off ping failed", err, {
						conversation: conv.id,
						chat,
					});
				}
			}
			// A response whose ping reached nobody keeps its dedup key —
			// consuming it would make the next bell for the same reply
			// skip, and the operator would never hear about the turn. A
			// timed-out send counts as undelivered: if it secretly landed,
			// a re-ping is noise; if it didn't, a consumed key is silence.
			if (pingKey !== undefined && !delivered) {
				pingedResponses.delete(pingKey);
				log.warn("spin-off ping reached no chat — response stays unpinged", {
					conversation: conv.id,
					trigger,
				});
			}
		},
	};
}
