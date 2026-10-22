import { Bot, type Api } from "grammy";
import { z } from "zod";
import type { MenuButton, Message } from "grammy/types";
import type { UIMessage } from "ai";
import type { AuthStore } from "../auth.ts";
import { paths, type Config, type ConfigRef, type TtsConfig } from "../config.ts";
import {
	formatAddress,
	channelOf,
	type Conversation,
	type ConversationAddress,
	type ConversationStore,
} from "../conversation.ts";
import type { System1Client } from "../system1.ts";
import {
	isRollingChat,
	projectRollText,
	rollingChatId,
	routeDm,
	routeDmMessage,
	type RollDeps,
} from "../rolling.ts";
import { userMessage, type Runtime, type TurnSink } from "../runtime.ts";
import type { ResumeOps } from "../turn-resume.ts";
import { log } from "../log.ts";
import { makeBellSink } from "./bell.ts";
import { CoalescingBuffer } from "./buffer.ts";
import {
	COMMAND_RE,
	COMMANDS,
	DM_COMMANDS,
	handleCommand,
	parseCommand,
	type CommandMemoryDeps,
} from "./commands.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import { SPEAK_CALLBACK } from "./delivery.ts";
import { floodWaitTransformer } from "./flood-wait.ts";
import { registerGenerationStop } from "./generation-stop.ts";
import {
	type GuestEnv,
	ensurePersonaClass,
	GUEST_REFUSAL,
	handleGuestUpdate,
	openGuestStore,
	refusalDue,
	routeMemberGuestMessage,
} from "./guest.ts";
import { MAIL_CALLBACK_RE, type TelegramMailApproval } from "./mail-approval.ts";
import {
	PROGRAM_CALLBACK_RE,
	type TelegramProgramApproval,
} from "./program-approval.ts";
import { sendRollMarker } from "./notify.ts";
import { registerRateButton } from "./rate-button.ts";
import { openRatings } from "./ratings.ts";
	import { SKILL_CALLBACK_RE, startSkillApproval } from "./skill-approval.ts";
	import {
		handleSkillCommand,
		handleTempSkillCallback,
		TEMP_SKILL_CALLBACK_RE,
		type SkillCommandDeps,
	} from "./skill-command.ts";
import { handleSpeakButton } from "./speak-button.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import { mediaFromMessage, mediaParts, saveAttachment, unhandledMediaKind } from "./media.ts";
import {
	openTelegramInbox,
	validatedInboxMedia,
	type InboxEntry,
	type InboxPayload,
} from "./inbox.ts";
import { openPings, type PingStore } from "./pings.ts";
import { refusalDispatcher, sendRefusal } from "./refusals.ts";
import { maybeRenameTopic, titleMetaFromService } from "./titles.ts";
import { navigateDm } from "./navigation.ts";
import { makeConversationDeliverySink, sharedChatPart } from "./turn-input.ts";

export const AUTH_TELEGRAM_TOKEN = "telegram";
const QUIET_WINDOW_MS = 500;
const COALESCE_MAX_WAIT_MS = 10_000;
const ATTACHMENT_FAILED_PREFIX = "[attachment failed to download:";
const OPERATOR_ONLY_REPLY = "This command is only available to operators.";
const OPERATOR_ONLY_COMMANDS = new Set([
	"/voice",
	"/memory",
	"/forget",
	"/compact",
	"/resume",
	"/decide",
	"/abandon",
	"/skill",
]);

// `message_thread_id` also rides on non-forum comment threads (is_topic_message unset) — those stay bare-chat.
export function conversationAddress(msg: {
	chat: { id: number; type: string };
	message_thread_id?: number;
	is_topic_message?: boolean;
}): ConversationAddress {
	if (
		msg.chat.type !== "private" &&
		msg.message_thread_id !== undefined &&
		msg.is_topic_message === true
	) {
		return { kind: "topic", chatId: msg.chat.id, threadId: msg.message_thread_id };
	}
	return { kind: "dm", chatId: msg.chat.id };
}

export interface BufferedItem {
	updateId: number;
	chatId: number;
	parts: UIMessage["parts"];
	replyTo: number | undefined;
	quoted?: { messageId: number; text: string };
	textIndex: number;
	hasText: boolean;
}

export class InboxRecordError extends Error {
	constructor(updateId: number, cause: unknown) {
		super(`Telegram intake failed before durable admission for update ${updateId}`, { cause });
	}
}

export interface BotDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	runtime: Runtime;
	titleFor(text: string): Promise<string | null>;
	transcribe(file: SpeechFile): Promise<string | null>;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
	memory?: CommandMemoryDeps;
	mail?: () => TelegramMailApproval | undefined;
	programApproval?: () => TelegramProgramApproval | undefined;
	followUpGate?: () => Pick<System1Client, "decide"> | undefined;
	resumeOps?: () => ResumeOps | undefined;
}

export interface RunningBot {
	bot: Bot;
	drainIntake(): Promise<void>;
	replayInbox(): Promise<void>;
	startPolling(): void;
}

export function accessGate(configRef: { current: Config }, opts?: { refusalTimeoutMs?: number }) {
	const dispatch =
		opts?.refusalTimeoutMs === undefined ? sendRefusal : refusalDispatcher(opts.refusalTimeoutMs);
	return async (
		ctx: {
			from?: { id: number } | undefined;
			chat?: { id: number; type: string } | undefined;
			update?: { callback_query?: { id: string } | undefined };
			api: Api;
		},
		next: () => Promise<void>,
	): Promise<void> => {
		if (!ctx.from) {
			log.debug("rejected update with no sender");
			return;
		}
		const cfg = configRef.current;
		const id = ctx.from.id;
		if (cfg.operators.includes(id)) {
			await next();
			return;
		}
		// A non-operator's callback tap lands here (ctx.chat is the message's chat);
		// it must be answered or the tap's spinner runs until Telegram expires it.
		if (ctx.update !== undefined && "callback_query" in ctx.update) {
			const q = ctx.update.callback_query;
			log.info("callback tap refused — not operator", { userId: id, chat: ctx.chat?.id });
			if (q !== undefined) {
				await withTimeout(
					ctx.api.answerCallbackQuery(q.id, { text: "operator only" }),
					"answerCallbackQuery",
				)
					.then(() => undefined)
					.catch((err: unknown) => log.debug("answerCallbackQuery failed", { error: String(err) }));
			}
			return;
		}
		if (ctx.chat?.type === "private") {
			if (cfg.guest === undefined || !cfg.allowedUsers.includes(id)) {
				log.info("dm refused — not an operator", {
					userId: id,
					guest: cfg.guest !== undefined,
				});
				if (refusalDue(id)) dispatch(ctx.api, id, id, GUEST_REFUSAL);
				return;
			}
			await next();
			return;
		}
		log.info("group message dropped — not operator", { userId: id, chat: ctx.chat?.id });
	};
}

export interface IntakeEnv {
	deps: BotDeps;
	api: Api;
	apiRoot: string | undefined;
	token: string;
	botUsername: string;
	titleAttempts: Set<string>;
	buffer: CoalescingBuffer<BufferedItem>;
	intake: Map<string, Promise<void>>;
	inbox: ReturnType<typeof openTelegramInbox>;
	pings: PingStore;
	bell(conv: Conversation): TurnSink;
}

export type FlushEnv = Pick<IntakeEnv, "deps" | "api" | "titleAttempts" | "inbox" | "bell">;

function rollDepsOf(deps: BotDeps): RollDeps {
	return {
		store: deps.store,
		runtime: deps.runtime,
		gapMinutes: () => deps.configRef.current.telegram.dmGapMinutes,
		...(deps.followUpGate === undefined ? {} : { gate: deps.followUpGate }),
	};
}

function replyNavigation(env: IntakeEnv, msg: Message, text: string): void {
	const addr = conversationAddress(msg);
	void withTimeout(
		env.api.sendMessage(msg.chat.id, text, {
			disable_notification: true,
			...(addr.kind === "topic" ? { message_thread_id: addr.threadId } : {}),
		}),
		"sendMessage (navigation reply)",
	)
		.then((sent) => {
			const messageId = z
				.object({ message_id: z.number().int().positive().safe() })
				.parse(sent).message_id;
			log.info("dm navigation reply delivered", {
				chat: msg.chat.id,
				thread: addr.kind === "topic" ? addr.threadId : null,
				replyTo: msg.message_id,
				messageId,
			});
		})
		.catch((err: unknown) => {
			log.warn("dm navigation reply failed", {
				chat: msg.chat.id,
				replyTo: msg.message_id,
				kind:
					err instanceof TelegramTimeoutError
						? "timeout"
						: err instanceof Error
							? err.name
							: "unknown",
				...(typeof err === "object" &&
				err !== null &&
				"error_code" in err &&
				typeof err.error_code === "number"
					? { status: err.error_code }
					: {}),
			});
		});
}

export function handleMessage(env: IntakeEnv, msg: Message, updateId: number): void {
	const { deps } = env;
	let admitted: string | null;
	try {
		admitted = env.inbox.admittedDestination(updateId, msg.chat.id, msg.message_id);
	} catch (err) {
		throw new InboxRecordError(updateId, err);
	}
	if (admitted !== null) {
		log.info("telegram intake redelivery — original admission stands", {
			updateId,
			conversation: admitted,
			message: msg.message_id,
		});
		return;
	}
	const text = msg.text ?? msg.caption ?? "";
	const addr = conversationAddress(msg);
	const rolling = msg.chat.type === "private" && addr.kind === "dm" && isRollingChat(addr.chatId);
	const lane = formatAddress(addr);
	log.debug("intake", {
		updateId,
		conversation: lane,
		message: msg.message_id,
		...(addr.kind === "topic" ? { thread: addr.threadId } : {}),
	});
	let media: ReturnType<typeof mediaFromMessage> = null;
	let mediaError: unknown = null;
	try {
		const extracted = mediaFromMessage(msg);
		media = extracted === null ? null : validatedInboxMedia(extracted);
	} catch (err) {
		mediaError = err;
	}
	const command =
		text !== "" && !media && mediaError === null ? parseCommand(text, env.botUsername) : null;
	if (command !== null && !command.forThisBot) return;
	if (
		command !== null &&
		OPERATOR_ONLY_COMMANDS.has(command.command) &&
		!deps.configRef.current.operators.includes(msg.from?.id ?? -1)
	) {
		log.info("privileged command refused — not operator", {
			command: command.command,
			userId: msg.from?.id ?? null,
			chat: msg.chat.id,
		});
		sendRefusal(env.api, msg.from?.id ?? msg.chat.id, msg.chat.id, OPERATOR_ONLY_REPLY);
		return;
	}
	if (command?.command === "/new" || command?.command === "/back") {
		if (!rolling) {
			replyNavigation(
				env,
				msg,
				"/new and /back work only in our private chat — group topics keep their own conversations.",
			);
			return;
		}
		if (command.arg !== "") {
			replyNavigation(
				env,
				msg,
				`use ${command.command} without arguments, then send your question.`,
			);
			return;
		}
		try {
			const result = navigateDm(
				{ store: deps.store, runtime: deps.runtime, inbox: env.inbox },
				{
					chatId: addr.chatId,
					updateId,
					messageId: msg.message_id,
					command: command.command === "/new" ? "new" : "back",
				},
			);
			if (!result.duplicate) {
				replyNavigation(
					env,
					msg,
					result.outcome === "new"
						? "— new conversation —"
						: result.outcome === "back"
							? "— previous conversation —"
							: "no earlier conversation",
				);
			}
		} catch (err) {
			log.error("dm navigation failed before durable admission", undefined, {
				updateId,
				chat: addr.chatId,
				errorKind: err instanceof Error ? err.name : "unknown",
			});
			throw new InboxRecordError(updateId, err);
		}
		return;
	}
	const conv = rolling ? null : deps.store.resolve(addr, paths.workspace());
	const topicMeta = conv !== null ? titleMetaFromService(msg) : null;
	if (topicMeta && conv !== null) {
		deps.store.setMeta(conv.id, topicMeta);
		if (topicMeta.titleImplicit) {
			log.info("implicit topic name — titling owed", {
				conversation: conv.id,
				title: topicMeta.title,
			});
		} else if (conv.titleImplicit) {
			log.info("topic renamed — titling debt settled", { conversation: conv.id });
		}
	}

	if (command !== null && COMMAND_RE.test(text)) {
		let target: Conversation | null = conv;
		let handled = false;
		try {
			if (target === null) {
				const cmd = command.command;
				const cls = dmClass(deps.configRef.current, addr.chatId);
				if (cls === null) {
					log.info("stranger refused — bot dm command", { userId: addr.chatId });
					refuseStranger(env.api, addr.chatId);
					return;
				}
				const routed = routeDm(
					rollDepsOf(deps),
					addr.chatId,
					cmd === "/voice" || cmd === "/memory" ? "command" : "current",
				);
				if (routed.rolled) void sendRollMarker(env.api, addr.chatId, routed.conv.id);
				target = ensurePersonaClass(
					deps,
					routed.conv,
					cls,
					cls === "guest" ? true : undefined,
					() => deps.store.rollDm(addr.chatId, paths.workspace()),
				);
			}
			if (command.command === "/skill") {
				// Submitting door (ruling 2026-10-21) — async fetch/scoring
				// off the sync intake path; it owns its replies.
				const skillDeps = skillCommandDeps(deps, env.api);
				void handleSkillCommand(skillDeps, target, text).catch((err: unknown) => {
					log.error("/skill failed", err, { conversation: target?.id ?? lane });
					withTimeout(
						env.api.sendMessage(
							target?.chatId ?? msg.chat.id,
							`command failed: ${err instanceof Error ? err.message : String(err)}`,
							target == null || target.threadId === null
								? {}
								: { message_thread_id: target.threadId },
						),
						"sendMessage (/skill failure)",
					).catch((e: unknown) => {
						log.warn("/skill failure reply failed", e);
					});
				});
				handled = true;
			} else {
				handled = handleCommand(
					{
						api: env.api,
						configRef: deps.configRef,
						store: deps.store,
						runtime: deps.runtime,
						botUsername: env.botUsername,
						...(deps.memory ? { memory: deps.memory } : {}),
						...(deps.resumeOps ? { resumeOps: deps.resumeOps } : {}),
					},
					target,
					text,
				);
			}
		} catch (err) {
			log.error("command failed", err, { conversation: target?.id ?? lane });
			withTimeout(
				env.api.sendMessage(
					target?.chatId ?? msg.chat.id,
					`command failed: ${err instanceof Error ? err.message : String(err)}`,
					target == null || target.threadId === null ? {} : { message_thread_id: target.threadId },
				),
				"sendMessage (command reply)",
			).catch((e: unknown) => {
				log.warn("command failure reply failed", e);
			});
			return;
		}
		if (handled) return;
	}

	if (text === "" && !media && mediaError === null) {
		const kind = unhandledMediaKind(msg);
		if (kind === null) {
			log.debug("dropped message with no text or media", { conversation: lane });
			return;
		}
		log.info("dropped unhandled media kind", {
			conversation: lane,
			kind,
			message: msg.message_id,
		});
		void withTimeout(
			env.api.sendMessage(
				msg.chat.id,
				`⚠ I can't read ${kind} yet — describe it in text if it matters.`,
				{
					disable_notification: true,
					...(addr.kind === "topic" ? { message_thread_id: addr.threadId } : {}),
				},
			),
			"sendMessage (unhandled media note)",
		)
			.then(() => undefined)
			.catch((err: unknown) => {
				log.warn("unhandled media note failed", err, { chat: msg.chat.id });
			});
		return;
	}

	const replyTo = msg.reply_to_message;
	const quotedReply =
		replyTo === undefined ||
		replyTo.forum_topic_created !== undefined ||
		(msg.message_thread_id !== undefined && replyTo.message_id === msg.message_thread_id)
			? undefined
			: replyTo;
	const pingedConv =
		quotedReply === undefined || !deps.configRef.current.operators.includes(msg.from?.id ?? -1)
			? null
			: (() => {
					const hit = env.pings.lookup(msg.chat.id, quotedReply.message_id);
					return hit !== null && deps.store.get(hit) !== null ? hit : null;
				})();
	const payload: InboxPayload = {
		conversationId: pingedConv ?? lane,
		chatId: msg.chat.id,
		messageId: msg.message_id,
		text,
		media,
		mediaError: mediaError === null ? null : String(mediaError),
		...(quotedReply === undefined || pingedConv !== null
			? {}
			: {
					quoted: {
						messageId: quotedReply.message_id,
						text: quotedReply.text ?? quotedReply.caption ?? "",
					},
				}),
	};
	try {
		if (!env.inbox.record(updateId, payload)) return;
	} catch (err) {
		throw new InboxRecordError(updateId, err);
	}
	void enqueuePersisted(env, { updateId, payload }).catch(() => {});
}

export function handleMessageDurably(env: IntakeEnv, msg: Message, updateId: number): void {
	try {
		handleMessage(env, msg, updateId);
	} catch (err) {
		throw err instanceof InboxRecordError ? err : new InboxRecordError(updateId, err);
	}
}

function enqueuePersisted(env: IntakeEnv, { updateId, payload }: InboxEntry): Promise<void> {
	const { conversationId: convId, text, media, mediaError, messageId, quoted } = payload;
	const { deps } = env;
	return enqueueIntake(env.intake, convId, async () => {
		const parts: UIMessage["parts"] = [];
		if (quoted !== undefined && quoted.text !== "") {
			parts.push({ type: "text", text: `[replying to: "${quoted.text.slice(0, 2_000)}"]` });
		}
		const textIndex = parts.length;
		const hasText = text !== "";
		if (hasText) parts.push({ type: "text", text });
		if (mediaError !== null) {
			log.error("media intake failed", mediaError, { conversation: convId });
			parts.push({
				type: "text",
				text: `${ATTACHMENT_FAILED_PREFIX} ${String(mediaError)}]`,
			});
		}

		if (media) {
			try {
				const file = await withTimeout(env.api.getFile(media.fileId), "getFile");
				const saved = await saveAttachment(media, file, env.apiRoot, env.token);
				let transcript: string | undefined;
				let transcriptionError: string | undefined;
				if (media.transcribable) {
					try {
						transcript =
							(await deps.transcribe({
								path: saved.path,
								mediaType: media.mimeType,
								filename: media.fileName,
							})) ?? undefined;
					} catch (err) {
						log.warn("transcription failed — attachment kept", err, {
							conversation: convId,
							file: media.fileName,
						});
						transcriptionError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
					}
				}
				parts.push(...mediaParts(media, saved, transcript, transcriptionError));
			} catch (err) {
				log.error("media intake failed", err, { conversation: convId });
				parts.push({
					type: "text",
					text: `${ATTACHMENT_FAILED_PREFIX} ${String(err)}]`,
				});
			}
		}

		env.buffer.push(convId, {
			updateId,
			parts,
			chatId: payload.chatId,
			replyTo: messageId,
			...(quoted !== undefined ? { quoted } : {}),
			textIndex,
			hasText,
		});
	});
}

function amendBufferedText(item: BufferedItem, text: string): void {
	if (item.hasText) {
		if (text === "") {
			item.parts.splice(item.textIndex, 1);
			item.hasText = false;
		} else {
			item.parts[item.textIndex] = { type: "text", text };
		}
		return;
	}
	if (text !== "") {
		item.parts.splice(item.textIndex, 0, { type: "text", text });
		item.hasText = true;
	}
}

export function handleEditedMessage(env: IntakeEnv, msg: Message): void {
	const hit = env.inbox.pendingByMessage(msg.chat.id, msg.message_id);
	if (hit === null) {
		log.info("edited message acked — edits do not re-enter history", {
			chat: msg.chat.id,
			message: msg.message_id,
		});
		return;
	}
	void enqueueIntake(env.intake, hit.laneKey, async () => {
		const pending = env.inbox.pendingByMessage(msg.chat.id, msg.message_id);
		if (pending === null) {
			log.info("edited message arrived after its batch committed", {
				chat: msg.chat.id,
				message: msg.message_id,
			});
			return;
		}
		let mediaUniqueId: string | null | undefined;
		try {
			mediaUniqueId = mediaFromMessage(msg)?.fileUniqueId ?? null;
		} catch {
			mediaUniqueId = undefined;
		}
		if (mediaUniqueId !== pending.mediaUniqueId) {
			log.info("edited message changed media — original stands", {
				chat: msg.chat.id,
				message: msg.message_id,
				updateId: pending.updateId,
			});
			return;
		}
		const text = msg.text ?? msg.caption ?? "";
		const amended = env.buffer.amend(
			pending.laneKey,
			(item) => item.updateId === pending.updateId,
			(item) => amendBufferedText(item, text),
		);
		if (!amended) {
			log.info("edited message missed the coalescing window", {
				chat: msg.chat.id,
				message: msg.message_id,
				updateId: pending.updateId,
			});
			return;
		}
		env.inbox.amendPendingText(pending.updateId, text);
		log.info("edited message amended in flight", {
			chat: msg.chat.id,
			message: msg.message_id,
			updateId: pending.updateId,
			lane: pending.laneKey,
		});
	});
}

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
	if (
		conv.threadId !== null &&
		conv.titleImplicit &&
		deps.configRef.current.titleModel !== undefined &&
		!env.titleAttempts.has(conv.id)
	) {
		const text = parts
			.map((p) => (p.type === "text" && !p.text.startsWith(ATTACHMENT_FAILED_PREFIX) ? p.text : ""))
			.join("\n")
			.trim();
		if (text !== "") {
			env.titleAttempts.add(conv.id);
			void maybeRenameTopic(
				{ api: env.api, store: deps.store, titleFor: deps.titleFor },
				conv,
				text,
			).catch((err: unknown) => {
				log.error("topic titling failed", err, { conversation: conv.id });
			});
		}
	}
	admitBatch(env, conv, convId, items, parts);
}

function dmClass(cfg: Config, chatId: number): "personal" | "guest" | null {
	return cfg.operators.includes(chatId)
		? "personal"
		: cfg.guest !== undefined && cfg.allowedUsers.includes(chatId)
			? "guest"
			: null;
}

function refuseStranger(api: Api, chatId: number): void {
	if (!refusalDue(chatId)) return;
	sendRefusal(api, chatId, chatId, GUEST_REFUSAL);
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
		const result = batch.some((i) => i.quoted !== undefined)
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

export { SHARED_CHAT_NOTE, sharedChatPart } from "./turn-input.ts";

// One wiring for every /skill door — the command and the temp-skill
// callback tap. Delivery is the same conversation-configured sink
// ordinary intake turns get.
function skillCommandDeps(deps: BotDeps, api: Api): SkillCommandDeps {
	const gate = deps.followUpGate?.();
	return {
		api,
		store: deps.store,
		runtime: deps.runtime,
		delivery: (target) => makeConversationDeliverySink(api, target, deps),
		...(gate !== undefined ? { gate } : {}),
	};
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
	env.inbox.commitBatch(
		items.map((i) => i.updateId),
		laneKey,
		() => {
			deps.store.append(conv.id, [message]);
		},
	);
	const sink = makeConversationDeliverySink(env.api, conv, deps, items[0]?.replyTo);
	try {
		deps.runtime.submitPersisted(conv, message, sink);
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
	env.inbox.commitBatch(
		items.map((i) => i.updateId),
		laneKey,
		() => {
			deps.store.append(conv.id, [message]);
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
		deps.runtime.submitPersisted(conv, message, sink);
	} catch (err) {
		log.error("turn submit failed after inbox commit", err, { conversation: conv.id });
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

function enqueueIntake(
	intake: Map<string, Promise<void>>,
	convId: string,
	step: () => Promise<void>,
): Promise<void> {
	const prev = intake.get(convId) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(step);
	intake.set(convId, next);
	void next.then(
		() => {
			if (intake.get(convId) === next) intake.delete(convId);
		},
		(err: unknown) => {
			log.error("intake step failed", err, { conversation: convId });
			if (intake.get(convId) === next) intake.delete(convId);
		},
	);
	return next;
}

export async function replayInbox(env: IntakeEnv): Promise<void> {
	const entries = env.inbox.pending();
	for (const entry of entries) {
		void enqueuePersisted(env, entry).catch(() => {});
	}
	log.info("telegram inbox recovery queued", { updates: entries.length });
}

export async function createBot(deps: BotDeps): Promise<RunningBot> {
	const token = await deps.auth.resolve(AUTH_TELEGRAM_TOKEN);
	const apiRoot = deps.configRef.current.telegram.apiRoot;
	const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
	bot.api.config.use(floodWaitTransformer());
	await withTimeout(bot.init(), "getMe");
	const base = {
		deps,
		api: bot.api,
		apiRoot,
		token,
		botUsername: bot.botInfo.username,
		titleAttempts: new Set<string>(),
	};
	const intake = new Map<string, Promise<void>>();
	const inbox = openTelegramInbox(deps.store.db);
	const pings = openPings(deps.store.db);
	const ratings = openRatings(deps.store.db);
	const bell = (conv: Conversation): TurnSink =>
		makeBellSink(
			{
				api: bot.api,
				store: deps.store,
				pings,
				operators: () => deps.configRef.current.operators,
				publicUrl: () => deps.configRef.current.publicUrl || undefined,
			},
			conv,
			"ping reply",
		);
	const guestStore = openGuestStore(deps.store.db);
	const buffer = new CoalescingBuffer<BufferedItem>(
		QUIET_WINDOW_MS,
		(convId, items) => flushConversation({ ...base, inbox, bell }, convId, items),
		COALESCE_MAX_WAIT_MS,
	);
	const env: IntakeEnv = { ...base, buffer, intake, inbox, pings, bell };

	const guestEnv: GuestEnv = {
		api: bot.api,
		store: deps.store,
		runtime: deps.runtime,
		configRef: deps.configRef,
		guestStore,
		botUsername: bot.botInfo.username,
		botUserId: bot.botInfo.id,
	};
	bot.on("guest_message", (ctx) => {
		if (ctx.guestMessage === undefined) return;
		void handleGuestUpdate(guestEnv, ctx.guestMessage, ctx.update.update_id).catch(
			(err: unknown) => {
				log.error("guest handler failed", err, { update: ctx.update.update_id });
			},
		);
	});
	bot.on("message", async (ctx, next) => {
		try {
			if (await routeMemberGuestMessage(guestEnv, ctx.message, ctx.update.update_id)) return;
		} catch (err) {
			log.error("member guest handler failed", err, { update: ctx.update.update_id });
		}
		await next();
	});

	registerGenerationStop(bot);

	bot.use(accessGate(deps.configRef));

	bot.on("message", (ctx) => handleMessageDurably(env, ctx.message, ctx.update.update_id));

	bot.on("edited_message", (ctx) => handleEditedMessage(env, ctx.editedMessage));

	bot.callbackQuery(SPEAK_CALLBACK, (ctx) => {
		void handleSpeakButton(ctx.callbackQuery, {
			api: bot.api,
			tts: deps.configRef.ttsDown ? undefined : deps.configRef.current.tts || undefined,
			synthesize: deps.synthesize,
		});
	});

	registerRateButton(bot, { api: bot.api, ratings });

	const skillApproval = startSkillApproval({
		api: bot.api,
		store: deps.store,
		workspaceDir: paths.workspace(),
		skillsDir: paths.skills(),
		proposedDir: paths.skillsProposed(),
	});
	bot.callbackQuery(SKILL_CALLBACK_RE, (ctx) => {
		const q = ctx.callbackQuery;
		if (!deps.configRef.current.operators.includes(q.from.id)) {
			log.warn("skill approval tap refused — not operator", { userId: q.from.id });
			void withTimeout(
				bot.api.answerCallbackQuery(q.id, { text: "operator only" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		void skillApproval.handleTap({
			id: q.id,
			data: q.data,
			...(q.message !== undefined
				? {
						message: {
							message_id: q.message.message_id,
							chat: { id: q.message.chat.id },
						},
					}
				: {}),
		});
	});

	bot.callbackQuery(TEMP_SKILL_CALLBACK_RE, (ctx) => {
		const q = ctx.callbackQuery;
		if (!deps.configRef.current.operators.includes(q.from.id)) {
			log.warn("temp skill tap refused — not operator", { userId: q.from.id });
			void withTimeout(
				bot.api.answerCallbackQuery(q.id, { text: "operator only" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		void handleTempSkillCallback(skillCommandDeps(deps, bot.api),
			{
				id: q.id,
				data: q.data,
				...(q.message !== undefined
					? {
							message: {
								message_id: q.message.message_id,
								chat: { id: q.message.chat.id },
							},
						}
					: {}),
			},
		).catch((err: unknown) => {
			log.error("temp skill callback failed", err, { query: q.id });
		});
	});

	bot.callbackQuery(MAIL_CALLBACK_RE, (ctx) => {
		if (!deps.configRef.current.operators.includes(ctx.callbackQuery.from.id)) {
			log.warn("mail approval tap refused — not operator", {
				userId: ctx.callbackQuery.from.id,
			});
			void withTimeout(
				bot.api.answerCallbackQuery(ctx.callbackQuery.id, { text: "operator only" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		const approval = deps.mail?.();
		if (!approval) {
			void withTimeout(
				bot.api.answerCallbackQuery(ctx.callbackQuery.id, { text: "mail is not configured" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		void approval.handleTap(ctx.callbackQuery);
	});

	bot.callbackQuery(PROGRAM_CALLBACK_RE, (ctx) => {
		const q = ctx.callbackQuery;
		// Same demotion guard as mail/skills: the live operators list,
		// not the list that admitted the chat.
		if (!deps.configRef.current.operators.includes(q.from.id)) {
			log.warn("program approval tap refused — not operator", { userId: q.from.id });
			void withTimeout(
				bot.api.answerCallbackQuery(q.id, { text: "operator only" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		const approval = deps.programApproval?.();
		if (!approval) {
			void withTimeout(
				bot.api.answerCallbackQuery(q.id, { text: "program approvals are not configured" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		void approval.handleTap({
			id: q.id,
			data: q.data,
			from: { id: q.from.id },
			...(q.message !== undefined
				? {
						message: {
							message_id: q.message.message_id,
							chat: { id: q.message.chat.id },
						},
					}
				: {}),
		});
	});

	bot.catch((err) => {
		log.error("bot error", err.error, { update: String(err.ctx?.update?.update_id) });
		if (err.error instanceof InboxRecordError) process.exit(1);
	});

	return {
		bot,
		replayInbox: () => replayInbox(env),
		startPolling() {
			void bot
				.start({ onStart: () => log.startup("long polling started") })
				.catch((err: unknown) => {
					log.error("long polling failed", err);
					process.exit(1);
				});
		},
		async drainIntake() {
			try {
				await buffer.drain();
			} catch (err) {
				log.warn("intake first drain failed — retrying after media chains", err);
			}
			await Promise.allSettled([...intake.values()]);
			await buffer.drain();
		},
	};
}

export function applyMenuButton(api: Api, publicUrl: string | undefined): void {
	const menu_button: MenuButton = publicUrl
		? {
				type: "web_app",
				text: "Settings",
				web_app: { url: `${publicUrl.replace(/\/+$/, "")}/t/settings` },
			}
		: { type: "default" };
	api
		.setChatMenuButton({ menu_button })
		.catch((err: unknown) => log.warn("menu button failed", err));
}

// setMyCommands persists server-side on the bot token; the list must be overwritten to ever change.
export function applyCommands(api: Api): void {
	api.setMyCommands([...COMMANDS]).catch((err: unknown) => log.warn("setMyCommands failed", err));
	api
		.setMyCommands([...DM_COMMANDS], { scope: { type: "all_private_chats" } })
		.catch((err: unknown) => log.warn("setMyCommands private scope failed", err));
}

export async function startBot(deps: BotDeps): Promise<RunningBot> {
	const running = await createBot(deps);
	const { bot } = running;
	log.info("telegram bot ready — polling after inbox replay", { bot: bot.botInfo.username });

	applyMenuButton(bot.api, deps.configRef.current.publicUrl);
	applyCommands(bot.api);

	return running;
}
