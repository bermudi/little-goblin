import type { Api } from "grammy";
import type { Conversation } from "../conversation-read.ts";
import type { TurnDone } from "../turn/sink.ts";
import { STATUS_TAIL_MARK } from "../agent/tts.ts";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import { isNotModifiedError, isPremiumGateError } from "./delivery-errors.ts";
import {
	disableMessageEffects,
	isPrivateDmAddress,
	messageEffectsUsable,
	nextDraftId,
	REASONING_BLOCK_OVERHEAD,
	RICH_LIMIT,
	SALUTE_EFFECT_ID,
} from "./delivery-text.ts";

// The rich-draft, rich-finalize, and rich-salute cluster of makeDeliverySink
// (#458). delivery.ts retains ownership of the richMode latch; this module
// reads and writes it through live ctx accessors.
export interface RichDeliveryCtx {
	api: Api;
	conv: Conversation;
	enqueue(fn: () => Promise<void>): void;
	settled(): Promise<void>;
	mayDeliver(): boolean;
	richMode(): boolean;
	setRichMode(value: boolean): void;
	rendered(): string;
	replyTo(): number | undefined;
	notifyUncertain(): Promise<void>;
	markUncertain(error: unknown, kind: string): void;
	buildKeyboard(): Array<Array<{ text: string; callback_data: string }>> | null;
	recordRichDelivery(messageId: number): void;
}

export function makeRichDelivery(
	ctx: RichDeliveryCtx,
	opts: { reasoning?: boolean; draftTtlMs: number },
): {
	pushDrafts(body: string): void;
	refreshRichDrafts(): void;
	onReasoningDelta(delta: string): void;
	finalize(done: TurnDone): Promise<boolean>;
	stampSuperseded(): Promise<boolean>;
} {
	const { api, conv } = ctx;
	const reasoningOn = opts.reasoning === true && conv.persona !== "guest";
	const answerDraftId = nextDraftId();
	const reasonDraftId = nextDraftId();
	let reasoningText = "";
	let reasoningPushed = 0;
	let reasoningSentAt = 0;
	let lastDraftBody = "";
	let lastDraftSentAt = 0;
	let draftLanded = false;

	function richFailure(err: unknown, method: string): never {
		log.warn("rich delivery failed — falling back to plain", err, {
			conversation: conv.id,
			chat: conv.chatId,
			method,
		});
		ctx.setRichMode(false);
		throw err;
	}

	function onReasoningDelta(delta: string): void {
		if (!ctx.richMode() || !reasoningOn) return;
		reasoningText += delta;
	}

	function refreshRichDrafts(): void {
		const body = ctx.rendered();
		const stale =
			body !== lastDraftBody ||
			Date.now() - lastDraftSentAt > opts.draftTtlMs ||
			reasoningText.length !== reasoningPushed ||
			(reasoningText !== "" && Date.now() - reasoningSentAt > opts.draftTtlMs);
		if (stale) pushDrafts(body);
	}

	function pushDrafts(body: string): void {
		if (
			reasoningOn &&
			reasoningText !== "" &&
			(reasoningText.length !== reasoningPushed || Date.now() - reasoningSentAt > 20_000)
		) {
			const snap = reasoningText;
			reasoningPushed = snap.length;
			reasoningSentAt = Date.now();
			ctx.enqueue(async () => {
				if (!ctx.mayDeliver() || !ctx.richMode()) return;
				const tail = snap.length > 4000 ? `…${snap.slice(-4000)}` : snap;
				try {
					await withTimeout(
						api.sendRichMessageDraft(conv.chatId, reasonDraftId, {
							blocks: [{ type: "thinking", text: tail }],
						}),
						"sendRichMessageDraft",
					);
				} catch (err) {
					if (isNotModifiedError(err)) return;
					richFailure(err, "sendRichMessageDraft");
				}
			});
		}
		lastDraftBody = body;
		lastDraftSentAt = Date.now();
		const method = body === "" ? "sendMessageDraft" : "sendRichMessageDraft";
		ctx.enqueue(async () => {
			if (!ctx.mayDeliver() || !ctx.richMode()) return;
			try {
				if (body === "") {
					await withTimeout(api.sendMessageDraft(conv.chatId, answerDraftId, ""), method);
				} else {
					await withTimeout(
						api.sendRichMessageDraft(conv.chatId, answerDraftId, { markdown: body }),
						method,
					);
					draftLanded = true;
				}
			} catch (err) {
				if (isNotModifiedError(err)) return;
				richFailure(err, method);
			}
		});
	}

	function reasoningBlock(budget: number): string {
		if (!reasoningOn) return "";
		const trimmed = reasoningText.trim();
		if (trimmed === "") return "";
		const escaped = trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		const room = Math.min(8_000, budget - REASONING_BLOCK_OVERHEAD);
		if (room <= 0) return "";
		if (escaped.length <= room) {
			return `<details><summary>Thinking</summary>\n<pre>${escaped}</pre>\n</details>\n\n`;
		}
		let tail = escaped.slice(-room);
		const semi = tail.indexOf(";");
		const amp = tail.indexOf("&");
		if (semi !== -1 && (amp === -1 || semi < amp)) tail = tail.slice(semi + 1);
		return `<details><summary>Thinking</summary>\n<pre>…${tail}</pre>\n</details>\n\n`;
	}

	async function finalize(done: TurnDone): Promise<boolean> {
		const body = ctx.rendered();
		if (body === "") {
			log.warn("completed turn rendered empty", {
				conversation: conv.id,
				chat: conv.chatId,
				...(conv.threadId !== null ? { thread: conv.threadId } : {}),
			});
			return true;
		}
		const md = reasoningBlock(RICH_LIMIT - body.length) + body;
		if (md.length > RICH_LIMIT) {
			log.warn("rich reply over cap — plain chunks from here", {
				conversation: conv.id,
				chars: md.length,
			});
			ctx.setRichMode(false);
			return false;
		}
		const replyTo = ctx.replyTo();
		const base = {
			...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
			...(replyTo !== undefined
				? { reply_parameters: { message_id: replyTo } }
				: {}),
		};
		const effect =
			done.kind === "completed" && isPrivateDmAddress(conv.id) && messageEffectsUsable()
				? { message_effect_id: SALUTE_EFFECT_ID }
				: {};
		const keyboard = done.kind === "completed" ? ctx.buildKeyboard() : null;
		const markup = keyboard === null ? {} : { reply_markup: { inline_keyboard: keyboard } };
		try {
			let sent;
			try {
				sent = await withTimeout(
					api.sendRichMessage(
						conv.chatId,
						{ markdown: md },
						{ ...base, ...effect, ...markup },
					),
					"sendRichMessage",
				);
			} catch (err) {
				if (effect.message_effect_id === undefined || !isPremiumGateError(err)) throw err;
				disableMessageEffects();
				log.info("message effect rejected — premium gate; dropped for this process", {
					conversation: conv.id,
					chat: conv.chatId,
				});
				if (!ctx.mayDeliver()) return true;
				sent = await withTimeout(
					api.sendRichMessage(conv.chatId, { markdown: md }, { ...base, ...markup }),
					"sendRichMessage",
				);
			}
			log.info("delivered rich", {
				conversation: conv.id,
				message: sent.message_id,
				...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				chars: md.length,
				reasoning: md !== body,
			});
			if (done.kind === "completed") {
				ctx.recordRichDelivery(sent.message_id);
				if (ctx.mayDeliver()) {
					await withTimeout(
						api.setMessageReaction(conv.chatId, sent.message_id, [
							{ type: "emoji", emoji: "🫡" },
						]),
						"setMessageReaction",
					).catch((err: unknown) => {
						log.debug("rich reaction failed", { error: String(err) });
					});
				}
			}
			return true;
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				ctx.markUncertain(err, "sendRichMessage");
				await ctx.notifyUncertain();
				return true;
			}
			log.warn("rich finalize failed — falling back to plain", err, {
				conversation: conv.id,
			});
			ctx.setRichMode(false);
			return false;
		}
	}

	async function stampSuperseded(): Promise<boolean> {
		const body = ctx.rendered();
		if (body === "" || !draftLanded) return false;
		const marked = `${body}${STATUS_TAIL_MARK}⏹ superseded`;
		ctx.enqueue(async () => {
			try {
				await withTimeout(
					api.sendRichMessageDraft(conv.chatId, answerDraftId, { markdown: marked }),
					"sendRichMessageDraft",
				);
				log.debug("delivery superseded marker on draft", { conversation: conv.id });
			} catch (err) {
				if (isNotModifiedError(err)) return;
				richFailure(err, "sendRichMessageDraft");
			}
		});
		await ctx.settled();
		return true;
	}

	return { pushDrafts, refreshRichDrafts, onReasoningDelta, finalize, stampSuperseded };
}
