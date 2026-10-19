import { randomUUID } from "node:crypto";
import { appLink } from "../app-link.ts";
import { appIdOf, type Conversation, type ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import { messageText } from "../memory/mod.ts";
import type { TurnSink } from "../runtime.ts";
import { API_CALL_TIMEOUT_MS, TelegramTimeoutError, withTimeout } from "./deadline.ts";
import type { DeliveryApi } from "./delivery.ts";
import type { PingStore } from "./pings.ts";

export interface BellDeps {
	api: DeliveryApi;
	store: ConversationStore;
	pings: PingStore;
	operators(): number[];
	publicUrl(): string | undefined;
	timeoutMs?: number;
}

const HEAD_LIMIT = 200;
const ERROR_HEAD_LIMIT = 120;

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
			const live = deps.store.get(conv.id);
			const title =
				live === null ? "app conversation" : (live.title ?? conv.title ?? "app conversation");
			let ping: string;
			let pingKey: string | undefined;
			if (done.kind === "completed") {
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
			for (const chat of deps.operators()) {
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
					try {
						deps.pings.record(chat, sent.message_id, conv.id);
						const dm = deps.store.currentDm(chat);
						if (dm === null) {
							log.debug("spin-off ping not journaled — no current DM", {
								conversation: conv.id,
								chat,
							});
						} else {
							deps.store.append(dm.id, [
								{
									id: randomUUID(),
									role: "assistant",
									parts: [{ type: "text", text: ping }],
								},
							]);
						}
					} catch (err) {
						log.error("spin-off ping landed but record/journal failed", err, {
							conversation: conv.id,
							chat,
							message: sent.message_id,
						});
					}
					log.info("spin-off ping", {
						conversation: conv.id,
						chat,
						message: sent.message_id,
						outcome: done.kind,
					});
				} catch (err) {
					if (err instanceof TelegramTimeoutError) {
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
