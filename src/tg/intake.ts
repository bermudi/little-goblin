// Message intake: the durable path a Telegram update takes from the
// access gate to the coalescing buffer — redelivery dedupe, the
// operator-only command gate, dm navigation (/new, /back), command
// dispatch (with /skill's async door), media extraction, and the inbox
// journal that makes admission crash-safe. design/telegram.md →
// Telegram intake & delivery. Sibling of flush.ts — only bot.ts joins
// them (it wires the buffer's flush callback).

import { z } from "zod";
import type { Api } from "grammy";
import type { ExternalReplyInfo, Message, MessageOrigin } from "grammy/types";
import type { UIMessage } from "ai";
import type { Config } from "../config-schema.ts";
import { paths } from "../home-layout.ts";
import type { Conversation } from "../conversation-read.ts";
import { formatAddress, parseAddress } from "../conversation-address.ts";
import type { ConversationAddress } from "../conversation-address.ts";
import { isRollingChat, routeDm, type RollDeps } from "../rolling.ts";
import { log } from "../log.ts";
import type { TurnSink } from "../turn/sink.ts";
import { CoalescingBuffer } from "./buffer.ts";
import { COMMAND_RE, handleCommand, parseCommand } from "./commands.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";
import type { BotDeps } from "./deps.ts";
import { ensurePersonaClass, guestRefusalText, refusalDue } from "./guest.ts";
import { sendRollMarker } from "./notify.ts";
import { handleSkillCommand, skillCommandDeps } from "./skill-command.ts";
import { pingTypingOnce } from "./delivery.ts";
import {
	mediaFromMessage,
	mediaParts,
	repliedMediaKind,
	saveAttachment,
	unhandledMediaKind,
} from "./media.ts";
import {
	openTelegramInbox,
	validatedInboxMedia,
	type InboxEntry,
	type InboxPayload,
} from "./inbox.ts";
import type { PingStore } from "./pings.ts";
import { sendRefusal } from "./refusals.ts";
import { titleMetaFromService } from "./titles.ts";
import { navigateDm } from "./navigation.ts";

export const QUIET_WINDOW_MS = 500;
export const COALESCE_MAX_WAIT_MS = 10_000;
export const ATTACHMENT_FAILED_PREFIX = "[attachment failed to download:";
// Model-view bound on quoted reply context; the durable row keeps the
// full text — longer input is marked, not silently cut (#493-L6).
export const QUOTED_TEXT_LIMIT = 8_000;
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

function externalOriginLabel(origin: MessageOrigin): string {
	switch (origin.type) {
		case "user": {
			const u = origin.sender_user;
			return u.username !== undefined ? `@${u.username}` : u.first_name;
		}
		case "hidden_user":
			return origin.sender_user_name;
		case "chat":
			return `chat "${origin.sender_chat.title ?? String(origin.sender_chat.id)}"`;
		case "channel":
			return `channel "${origin.chat.title ?? String(origin.chat.id)}"`;
	}
}

const EXTERNAL_MEDIA_KINDS: [keyof ExternalReplyInfo, string][] = [
	["photo", "a photo"],
	["live_photo", "a live photo"],
	["video", "a video"],
	["video_note", "a video note"],
	["animation", "an animation"],
	["audio", "an audio file"],
	["voice", "a voice message"],
	["document", "a document"],
	["sticker", "a sticker"],
	["story", "a story"],
	["paid_media", "paid media"],
	["contact", "a contact"],
	["dice", "a dice roll"],
	["game", "a game"],
	["giveaway", "a giveaway"],
	["giveaway_winners", "a giveaway result"],
	["invoice", "an invoice"],
	["location", "a location"],
	["venue", "a venue"],
	["poll", "a poll"],
	["checklist", "a checklist"],
];

function describeExternalReply(ext: ExternalReplyInfo): string {
	const kind = EXTERNAL_MEDIA_KINDS.find(([key]) => ext[key] !== undefined)?.[1] ?? "a message";
	return `external reply to ${kind} from ${externalOriginLabel(ext.origin)}`;
}

function forwardOriginLabel(origin: MessageOrigin): string {
	switch (origin.type) {
		case "user": {
			const u = origin.sender_user;
			const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
			return name !== "" ? name : `user ${u.id}`;
		}
		case "hidden_user":
			return origin.sender_user_name;
		case "chat":
			return origin.sender_chat.title ?? `chat ${origin.sender_chat.id}`;
		case "channel":
			return origin.chat.title ?? `channel ${origin.chat.id}`;
	}
}

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
	quoted?:
		| {
				messageId: number;
				text: string;
				excerpt?: boolean | undefined;
				mediaKind?: string | undefined;
			}
		| undefined;
	textIndex: number;
	hasText: boolean;
}

export class InboxRecordError extends Error {
	constructor(updateId: number, cause: unknown) {
		super(`Telegram intake failed before durable admission for update ${updateId}`, { cause });
	}
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

export function rollDepsOf(deps: BotDeps): RollDeps {
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
	// Forwarded text arrives indistinguishable from the sender's own words
	// — the model needs the origin marker up front (#493-L5).
	const body = msg.text ?? msg.caption ?? "";
	const text =
		msg.forward_origin === undefined
			? body
			: `[Forwarded from ${forwardOriginLabel(msg.forward_origin)} at ${new Date(msg.forward_origin.date * 1000).toISOString()}]${
					body === "" ? "" : `\n${body}`
				}`;
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
	if (command !== null && !COMMAND_RE.test(text)) {
		// Slash-shaped text matching no known command gets a correction in
		// private or when addressed to this bot, and never reaches the
		// inbox as chat text (#487). A bare /cmd in a group is not ours to
		// answer — it may be another bot's — so it is dropped silently.
		if (msg.chat.type === "private" || command.addressed) {
			log.info("unknown command refused", {
				command: command.command,
				userId: msg.from?.id ?? null,
				chat: msg.chat.id,
			});
			replyNavigation(
				env,
				msg,
				command.command === "/model"
					? "The model picker lives in the app — Settings → model."
					: `Unknown command ${command.command}. Try /help.`,
			);
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
					log.info("stranger refused — bot dm command", {
						userId: addr.chatId,
						reason: "stranger",
					});
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
	// A reply whose target lives in another chat arrives as external_reply
	// with no reply_to_message. It is still quoted context — quote.text when
	// the sender selected one, else a placeholder naming origin + media kind
	// so the reply is never silently dropped (#476).
	// An empty quote is a reply to media — remember what kind so the model
	// view can still mark the reply (#493-L8).
	const quotedMedia =
		quotedReply !== undefined && (quotedReply.text ?? quotedReply.caption ?? "") === ""
			? repliedMediaKind(quotedReply)
			: null;
	const quoted =
		pingedConv !== null
			? undefined
			: quotedReply !== undefined
				? {
						messageId: quotedReply.message_id,
						// A sender-selected quote is the excerpt they pointed
						// at — preferring the parent's whole text would inject
						// context they never referenced (#475).
						...(msg.quote?.text !== undefined
							? { text: msg.quote.text, excerpt: true as const }
							: {
									text: quotedReply.text ?? quotedReply.caption ?? "",
									...(quotedMedia !== null ? { mediaKind: quotedMedia } : {}),
								}),
					}
				: msg.external_reply !== undefined
					? {
							messageId: msg.external_reply.message_id ?? -1,
							...(msg.quote?.text !== undefined
								? { text: msg.quote.text, excerpt: true as const }
								: {
										text: `[${describeExternalReply(msg.external_reply)}]`,
									}),
						}
					: undefined;
	const payload: InboxPayload = {
		conversationId: pingedConv ?? lane,
		chatId: msg.chat.id,
		messageId: msg.message_id,
		...(addr.kind === "topic" ? { threadId: addr.threadId } : {}),
		text,
		media,
		mediaError: mediaError === null ? null : String(mediaError),
		...(quoted !== undefined ? { quoted } : {}),
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
		if (quoted !== undefined) {
			parts.push({
				type: "text",
				text:
					quoted.text === ""
						? `[replying to a ${quoted.mediaKind !== undefined ? `${quoted.mediaKind} ` : ""}message]`
						: `[replying to${quoted.excerpt === true ? " selected excerpt" : ""}: "${
								quoted.text.length > QUOTED_TEXT_LIMIT
									? `${quoted.text.slice(0, QUOTED_TEXT_LIMIT)}…[truncated ${quoted.text.length - QUOTED_TEXT_LIMIT} chars]`
									: quoted.text
							}"]`,
			});
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
						// The attachment still lands for the model — this note
						// tells the operator the audio wasn't heard, like the
						// app's chip surfacing the same error.
						const noteAddr = parseAddress(convId);
						void withTimeout(
							env.api.sendMessage(
								payload.chatId,
								`⚠️ Couldn't transcribe this voice note: ${transcriptionError.slice(0, 200)}`,
								{
									disable_notification: true,
									...(noteAddr?.kind === "topic"
										? { message_thread_id: noteAddr.threadId }
										: {}),
								},
							),
							"sendMessage (transcription note)",
						)
							.then(() => undefined)
							.catch((noteErr: unknown) => {
								log.warn("transcription note failed", noteErr, { chat: payload.chatId });
							});
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

		const first = env.buffer.push(convId, {
			updateId,
			parts,
			chatId: payload.chatId,
			replyTo: messageId,
			...(quoted !== undefined ? { quoted } : {}),
			textIndex,
			hasText,
		});
		if (first) pingTypingOnce(env.api, payload.chatId, payload.threadId ?? null);
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

// An edit that lands after its batch committed cannot re-enter history
// (settled ruling) — ack it in-channel so it isn't silently ignored
// (#493-L7).
function notifyEditMissed(env: IntakeEnv, msg: Message): void {
	const addr = conversationAddress(msg);
	void withTimeout(
		env.api.sendMessage(
			msg.chat.id,
			"Edit not applied — I already read the original. Send it again to change it.",
			{
				reply_parameters: { message_id: msg.message_id },
				...(addr.kind === "topic" ? { message_thread_id: addr.threadId } : {}),
			},
		),
		"sendMessage (post-commit edit notice)",
	)
		.then(() => undefined)
		.catch((err: unknown) => {
			log.warn("post-commit edit notice failed", err, { chat: msg.chat.id });
		});
}

export function handleEditedMessage(env: IntakeEnv, msg: Message): void {
	const hit = env.inbox.pendingByMessage(msg.chat.id, msg.message_id);
	if (hit === null) {
		log.info("edited message acked — edits do not re-enter history", {
			chat: msg.chat.id,
			message: msg.message_id,
		});
		notifyEditMissed(env, msg);
		return;
	}
	void enqueueIntake(env.intake, hit.laneKey, async () => {
		const pending = env.inbox.pendingByMessage(msg.chat.id, msg.message_id);
		if (pending === null) {
			log.info("edited message arrived after its batch committed", {
				chat: msg.chat.id,
				message: msg.message_id,
			});
			notifyEditMissed(env, msg);
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

export function dmClass(cfg: Config, chatId: number): "personal" | "guest" | null {
	return cfg.operators.includes(chatId)
		? "personal"
		: cfg.guest !== undefined && cfg.allowedUsers.includes(chatId)
			? "guest"
			: null;
}

export function refuseStranger(api: Api, chatId: number): void {
	if (!refusalDue(chatId)) return;
	// A stranger's DM chat id IS the sender's Telegram user id.
	sendRefusal(api, chatId, chatId, guestRefusalText(chatId));
}
