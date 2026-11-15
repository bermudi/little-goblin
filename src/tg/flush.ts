// Flush: what happens when the coalescing window closes — rolling-dm
// routing (navigation archives, stranger refusal, re-pinning), topic
// titling debt, and durable admission (append inside the inbox
// transaction, then submit) for both telegram and app lanes. Sibling
// of intake.ts — it sees only FlushEnv, the strictly-smaller slice of
// IntakeEnv; only bot.ts imports both.

import type { UIMessage } from "ai";
import { paths } from "../home-layout.ts";
import type { Conversation } from "../conversation-read.ts";
import { channelOf } from "../conversation-address.ts";
import { projectRollText, rollingChatId, routeDm, routeDmMessage } from "../rolling.ts";
import { userMessage } from "../runtime.ts";
import { log } from "../log.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import { ensurePersonaClass } from "./guest.ts";
import { sendRollMarker } from "./notify.ts";
import {
	ATTACHMENT_FAILED_PREFIX,
	type BufferedItem,
	dmClass,
	type FlushEnv,
	refuseStranger,
	rollDepsOf,
} from "./intake.ts";
import { maybeRenameTopic } from "./titles.ts";
import { makeConversationDeliverySink, sharedChatPart } from "./turn-input.ts";

export function flushConversation(
	env: FlushEnv,
	convId: string,
	items: BufferedItem[],
): void | Promise<void> {
	const chatId = rollingChatId(convId);
	if (chatId !== null) return flushRolling(env, chatId, convId, items);
	const { deps } = env;
	const conv = deps.store.get(convId);
	if (!conv) {
		if (channelOf(convId) === "app") {
			dropAppBatch(env, convId, items);
			return;
		}
		throw new Error(`flush for missing conversation: ${convId}`);
	}
	const parts = items.flatMap((i) => i.parts);
	log.debug("coalesced turn input", { conversation: convId, items: items.length });
	if (channelOf(conv.id) === "app") {
		admitAppBatch(env, conv, convId, items, parts);
		return;
	}
	if (conv.threadId !== null && conv.titleImplicit && !env.titleAttempts.has(conv.id)) {
		const text = parts
			.map((p) => (p.type === "text" && !p.text.startsWith(ATTACHMENT_FAILED_PREFIX) ? p.text : ""))
			.join("\n")
			.trim();
		if (text !== "") {
			const cfg = deps.configRef.current;
			env.titleAttempts.add(conv.id);
			void maybeRenameTopic(
				{ api: env.api, store: deps.store, titleFor: deps.titleFor },
				conv,
				text,
				conv.model ?? cfg.telegram.model ?? cfg.model,
			).catch((err: unknown) => {
				log.error("topic titling failed", err, { conversation: conv.id });
			});
		}
	}
	admitBatch(env, conv, convId, items, parts);
}

function refuseDroppedBatch(
	env: FlushEnv,
	chatId: number,
	laneKey: string,
	batch: BufferedItem[],
): void {
	env.inbox.commitBatch(
		batch.map((i) => i.updateId),
		laneKey,
		() => {},
	);
	log.info("dm batch dropped — sender left both lists mid-flight", {
		chat: chatId,
		updateIds: batch.map((i) => i.updateId),
	});
	refuseStranger(env.api, chatId);
}

async function flushRolling(
	env: FlushEnv,
	chatId: number,
	laneKey: string,
	items: BufferedItem[],
): Promise<void> {
	const { deps } = env;
	log.debug("coalesced turn input", { conversation: laneKey, items: items.length });
	let remaining = archiveNavigatedInput(env, laneKey, items);
	while (remaining.length > 0) {
		const batch = remaining;
		let cls = dmClass(deps.configRef.current, chatId);
		if (cls === null) {
			refuseDroppedBatch(env, chatId, laneKey, batch);
			return;
		}
		const stillRouteable = (): boolean =>
			env.inbox.assertRouteable(
				batch.map((item) => item.updateId),
				laneKey,
			);
		// Reply-pinning only when every item quotes: a mixed batch's
		// non-quoted items still earn the follow-up check.
		const result = batch.every((i) => i.quoted !== undefined)
			? routeDm(rollDepsOf(deps), chatId, "reply")
			: await routeDmMessage(
					rollDepsOf(deps),
					chatId,
					projectRollText(batch.flatMap((i) => i.parts)),
					stillRouteable,
				);
		remaining = archiveNavigatedInput(env, laneKey, batch);
		if (remaining.length !== batch.length) continue;
		if (result.rolled) await sendRollMarker(env.api, chatId, result.conv.id);
		remaining = archiveNavigatedInput(env, laneKey, batch);
		if (remaining.length !== batch.length) continue;
		const current = deps.store.currentDm(chatId);
		if (current === null) throw new Error(`DM ${chatId} has no current conversation after routing`);
		if (current.id !== result.conv.id) {
			log.info("dm admission re-pinned", {
				address: laneKey,
				from: result.conv.id,
				to: current.id,
			});
		}
		cls = dmClass(deps.configRef.current, chatId);
		if (cls === null) {
			refuseDroppedBatch(env, chatId, laneKey, batch);
			return;
		}
		const pinned = ensurePersonaClass(deps, current, cls, cls === "guest" ? true : undefined, () =>
			deps.store.rollDm(chatId, paths.workspace()),
		);
		admitBatch(
			env,
			pinned,
			laneKey,
			remaining,
			remaining.flatMap((i) => i.parts),
		);
		return;
	}
}

function archiveNavigatedInput(
	env: FlushEnv,
	laneKey: string,
	items: BufferedItem[],
): BufferedItem[] {
	const groups = new Map<string, BufferedItem[]>();
	const normal: BufferedItem[] = [];
	const pending = new Set(
		env.inbox.pendingIds(
			items.map((item) => item.updateId),
			laneKey,
		),
	);
	const committed = items.filter((item) => !pending.has(item.updateId));
	if (committed.length > 0) {
		log.info("telegram flush skipping already committed input", {
			address: laneKey,
			updateIds: committed.map((item) => item.updateId),
		});
	}
	for (const item of items) {
		if (!pending.has(item.updateId)) continue;
		const target = env.inbox.archivedTarget(item.updateId, laneKey);
		if (target === null) normal.push(item);
		else {
			const group = groups.get(target) ?? [];
			group.push(item);
			groups.set(target, group);
		}
	}
	for (const [target, group] of groups) {
		const updateIds = group.map((item) => item.updateId);
		env.inbox.commitBatch(updateIds, laneKey, () => {
			env.deps.store.append(target, [userMessage(group.flatMap((item) => item.parts))]);
		});
		log.info("telegram navigation input archived without replay", {
			address: laneKey,
			conversation: target,
			updateIds,
		});
	}
	return normal;
}

function admitBatch(
	env: FlushEnv,
	conv: Conversation,
	laneKey: string,
	items: BufferedItem[],
	parts: UIMessage["parts"],
): void {
	const { deps } = env;
	const audience = sharedChatPart(conv.id, conv.chatId);
	const message = userMessage(audience === null ? parts : [audience, ...parts]);
	// The append runs inside commitBatch's transaction — capturing its seq
	// here hands submitPersisted the event's true identity without a lookup.
	let seq: number | undefined;
	env.inbox.commitBatch(
		items.map((i) => i.updateId),
		laneKey,
		() => {
			seq = deps.store.append(conv.id, [message])[0]!;
		},
	);
	const sink = makeConversationDeliverySink(env.api, conv, deps, items[0]?.replyTo);
	try {
		// commitBatch either runs the append inside its transaction or
		// throws — if that contract ever breaks, fail here instead of
		// submitting a turn with no event identity.
		if (seq === undefined) {
			throw new Error("inbox commit did not append the turn input");
		}
		deps.runtime.submitPersisted(conv, message, sink, seq);
	} catch (err) {
		log.error("turn submit failed after inbox commit", err, { conversation: conv.id });
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

function dropAppBatch(env: FlushEnv, convId: string, items: BufferedItem[]): void {
	env.inbox.commitBatch(
		items.map((i) => i.updateId),
		convId,
		() => {},
	);
	log.warn("ping reply dropped — app conversation deleted", {
		conversation: convId,
		items: items.length,
	});
	for (const chat of new Set(items.map((i) => i.chatId))) {
		void withTimeout(
			env.api.sendMessage(chat, "not sent — that app conversation was deleted", {
				disable_notification: true,
			}),
			"sendMessage (ping reply drop)",
		).catch((err: unknown) => {
			if (err instanceof TelegramTimeoutError) {
				log.warn("ping reply drop ack delivery uncertain — send timed out", {
					chat,
					conversation: convId,
					label: err.label,
				});
				return;
			}
			log.warn("ping reply drop ack failed", err, {
				chat,
				conversation: convId,
			});
		});
	}
}

function admitAppBatch(
	env: FlushEnv,
	conv: Conversation,
	laneKey: string,
	items: BufferedItem[],
	parts: UIMessage["parts"],
): void {
	const { deps } = env;
	const message = userMessage(parts);
	// Same capture as the telegram batch: the seq rides out of the
	// commitBatch transaction so the queued turn owns its real event.
	let seq: number | undefined;
	env.inbox.commitBatch(
		items.map((i) => i.updateId),
		laneKey,
		() => {
			seq = deps.store.append(conv.id, [message])[0]!;
		},
	);
	for (const item of items) {
		log.info("ping reply routed", {
			chat: item.chatId,
			message: item.replyTo,
			conversation: conv.id,
		});
	}
	for (const chat of new Set(items.map((i) => i.chatId))) {
		void withTimeout(
			env.api.sendMessage(chat, `sent to ${conv.title ?? "app conversation"}`, {
				disable_notification: true,
			}),
			"sendMessage (ping reply ack)",
		).catch((err: unknown) => {
			if (err instanceof TelegramTimeoutError) {
				log.warn("ping reply ack delivery uncertain — send timed out", {
					chat,
					conversation: conv.id,
					label: err.label,
				});
				return;
			}
			log.warn("ping reply ack failed", err, {
				chat,
				conversation: conv.id,
			});
		});
	}
	const sink = env.bell(conv);
	try {
		// Same contract as the telegram batch above: no append, no submit.
		if (seq === undefined) {
			throw new Error("inbox commit did not append the turn input");
		}
		deps.runtime.submitPersisted(conv, message, sink, seq);
	} catch (err) {
		log.error("turn submit failed after inbox commit", err, { conversation: conv.id });
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
