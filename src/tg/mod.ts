// Telegram composition — only this directory knows grammy.

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
import type { JevClient } from "../jev.ts";
import {
	isRollingChat,
	projectRollText,
	rollingChatId,
	routeDm,
	routeDmMessage,
	type RollDeps,
} from "../rolling.ts";
import { userMessage, type Runtime, type TurnSink } from "../runtime.ts";
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
import { makeDeliverySink, SPEAK_CALLBACK } from "./delivery.ts";
import {
	type GuestEnv,
	handleGuestUpdate,
	openGuestStore,
	routeMemberGuestMessage,
} from "./guest.ts";
import { MAIL_CALLBACK_RE, type MailApproval } from "./mail-approval.ts";
import { sendRollMarker } from "./notify.ts";
import { registerRateButton } from "./rate-button.ts";
import { openRatings } from "./ratings.ts";
import { handleSpeakButton } from "./speak-button.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import { mediaFromMessage, mediaParts, saveAttachment } from "./media.ts";
import {
	openTelegramInbox,
	validatedInboxMedia,
	type InboxEntry,
	type InboxPayload,
} from "./inbox.ts";
import { openPings, type PingStore } from "./pings.ts";
import { maybeRenameTopic, titleMetaFromService } from "./titles.ts";
import { navigateDm } from "./navigation.ts";

export const AUTH_TELEGRAM_TOKEN = "telegram";
// 500ms of quiet seals a burst: a chunk straddling a long-poll
// boundary waits out a full Telegram API round-trip (~185ms from this
// box), so shorter windows split pastes. But the window is a flat
// latency tax on every turn — smaller only becomes safe with a
// self-hosted bot-api beside the poller.
const QUIET_WINDOW_MS = 500;
// A source dribbling messages faster than the quiet window must not
// postpone its turn forever — the ceiling flushes mid-dribble instead.
const COALESCE_MAX_WAIT_MS = 10_000;
// Sentinel for media that failed intake — kept out of topic-title input
// or a download error becomes the conversation's name.
const ATTACHMENT_FAILED_PREFIX = "[attachment failed to download:";

// Conversation identity IS the Telegram address. `message_thread_id`
// also rides on non-forum comment threads (is_topic_message stays
// unset, bots can't post) — those stay bare-chat. Private chats always
// address the rolling DM lane (design/telegram.md → Rolling DM).
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

interface BufferedItem {
	updateId: number;
	// The chat the message arrived in — an app lane needs it to ack the
	// ping reply, the conversation's own chat_id being the 0 filler.
	chatId: number;
	parts: UIMessage["parts"];
	replyTo: number | undefined;
	// Set when the message quoted another. Presence alone counts as a
	// reply for rolling-DM routing — an empty quote still joins.
	quoted?: { messageId: number; text: string };
}

// A failed durable insert must stop polling, not allow grammy to acknowledge
// this update (or any later one) with its next getUpdates offset.
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
	// Topic titler — one small model call per implicitly-named topic.
	// null = no usable title this attempt.
	titleFor(text: string): Promise<string | null>;
	// Speech → text for voice and video notes; attached audio files are
	// data, left to the transcribe tool. null = off, capped, or no speech.
	transcribe(file: SpeechFile): Promise<string | null>;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
	// Long-term memory wiring for /memory + /forget — absent = disabled.
	memory?: CommandMemoryDeps;
	// Resolved per tap (built right after the bot — it needs bot.api).
	// Absent = mail never wired: a stale button gets an answer, never a hang.
	mail?: () => MailApproval;
	// The Rolling DM follow-up check, resolved per call (the reviewer is
	// built after the bot). Absent = no check: a past-gap burst joins current.
	followUpGate?: () => Pick<JevClient, "decide"> | undefined;
}

export interface RunningBot {
	bot: Bot;
	// Wait out media chains, then flush the buffer so buffered input submits.
	drainIntake(): Promise<void>;
	replayInbox(): Promise<void>;
	startPolling(): void;
}

// The access-control boundary: gates every update first thing, read
// per-message so mini-app saves apply without a restart.
export function allowedUserGate(configRef: { current: Config }) {
	return async (
		ctx: { from?: { id: number } | undefined },
		next: () => Promise<void>,
	): Promise<void> => {
		if (!ctx.from) {
			// Service updates carry no sender — routine, not a warn.
			log.debug("rejected update with no sender");
			return;
		}
		if (!configRef.current.allowedUsers.includes(ctx.from.id)) {
			log.warn("rejected user", { userId: ctx.from.id });
			return;
		}
		await next();
	};
}

// ---------- intake router ----------
//
// The message router and the coalescing flush; createBot only wires
// grammy to these.

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
	// The ping→conversation map: a swipe-reply routes into the app conversation that rang.
	pings: PingStore;
	// The headless sink app-lane turns submit with; the bell rings when the turn lands.
	bell(conv: Conversation): TurnSink;
	// Guest mode: open to third-party summonses? Read per burst — the
	// system prompt is frozen per conversation (cache stability) while
	// openness changes with /open and /off.
	isChatOpen: (chatId: number) => boolean;
}

export type FlushEnv = Pick<
	IntakeEnv,
	"deps" | "api" | "titleAttempts" | "inbox" | "bell" | "isChatOpen"
>;

// Assembled per call so a mini-app save (dmGapMinutes) and the
// late-built reviewer's gate read live config, not boot-time wiring.
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
		env.api.sendMessage(
			msg.chat.id,
			text,
			addr.kind === "topic" ? { message_thread_id: addr.threadId } : {},
		),
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
	// Redelivery is identity, not routing (#77): an admitted update
	// keeps its durable row's destination whatever routing would
	// recompute now — a ping's app conversation can be deleted between
	// delivery and redelivery, and the recomputed fallback must not
	// corrupt an ordinary duplicate. The row is never rewritten; its
	// flush owns the deleted-target landing (dropAppBatch).
	let admitted: string | null;
	try {
		admitted = env.inbox.admittedDestination(updateId, msg.chat.id, msg.message_id);
	} catch (err) {
		// The journal itself is unreadable — same fatal class as a failed record.
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
	// A private chat's lane is the rolling address — the concrete
	// dm:<chat>:<n> conversation is routed at flush. Every other lane
	// IS its conversation id, resolved eagerly here.
	const rolling = msg.chat.type === "private" && addr.kind === "dm" && isRollingChat(addr.chatId);
	const lane = formatAddress(addr);
	log.debug("intake", {
		updateId,
		conversation: lane,
		message: msg.message_id,
		...(addr.kind === "topic" ? { thread: addr.threadId } : {}),
	});
	// Media wins over slash-looking captions, and command ownership
	// parses before any conversation creation or routing.
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
	// conv is read before the patch so both titleImplicit transitions
	// log; topic service meta exists only on non-private lanes.
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
			// Rolling DM: /voice and /memory own their roll; every other
			// command acts on the current conversation and never rolls.
			if (target === null) {
				const cmd = command.command;
				const routed = routeDm(
					rollDepsOf(deps),
					addr.chatId,
					cmd === "/voice" || cmd === "/memory" ? "command" : "current",
				);
				if (routed.rolled) void sendRollMarker(env.api, addr.chatId, routed.conv.id);
				target = routed.conv;
			}
			handled = handleCommand(
				{
					api: env.api,
					configRef: deps.configRef,
					store: deps.store,
					runtime: deps.runtime,
					botUsername: env.botUsername,
					...(deps.memory ? { memory: deps.memory } : {}),
				},
				target,
				text,
			);
		} catch (err) {
			// Commands bypass the inbox entirely — a failure here is not an
			// InboxRecordError, and must not reach handleMessageDurably as
			// one. Log it, tell the operator, let grammy consume the update.
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
		// Service messages, join/leave, uncovered media kinds — routine drop.
		log.debug("dropped message with no text or media", { conversation: lane });
		return;
	}

	const replyTo = msg.reply_to_message;
	// Telegram reports the topic's root service message as reply_to_message
	// on every ordinary message inside a forum topic (and a threaded-mode
	// private chat) — flagged forum_topic_created, or flagless where the
	// target IS the thread root. Thread plumbing, not an operator reply:
	// counting it routes every burst as "reply" and skips the follow-up check.
	const quotedReply =
		replyTo === undefined ||
		replyTo.forum_topic_created !== undefined ||
		(msg.message_thread_id !== undefined && replyTo.message_id === msg.message_thread_id)
			? undefined
			: replyTo;
	// A swipe-reply to a delegation ping routes into the app conversation
	// that rang; the payload carries no quoted part — the app conversation
	// doesn't need the ping text. A deleted target degrades to ordinary.
	const pingedConv =
		quotedReply === undefined
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
	void enqueuePersisted(env, { updateId, payload }).catch(() => {
		// The intake chain logged the failure; the durable row remains for replay.
	});
}

export function handleMessageDurably(env: IntakeEnv, msg: Message, updateId: number): void {
	try {
		handleMessage(env, msg, updateId);
	} catch (err) {
		// Conversation creation and topic metadata happen before record().
		// Failure at either boundary cannot become a consumed update.
		throw err instanceof InboxRecordError ? err : new InboxRecordError(updateId, err);
	}
}

function enqueuePersisted(env: IntakeEnv, { updateId, payload }: InboxEntry): Promise<void> {
	const { conversationId: convId, text, media, mediaError, messageId, quoted } = payload;
	const { deps } = env;
	return enqueueIntake(env.intake, convId, async () => {
		const parts: UIMessage["parts"] = [];
		// The quote leads — it reads as the operator's own "about this" prefix.
		if (quoted !== undefined && quoted.text !== "") {
			parts.push({ type: "text", text: `[replying to: "${quoted.text.slice(0, 2_000)}"]` });
		}
		if (text !== "") parts.push({ type: "text", text });
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
				if (media.transcribable) {
					try {
						transcript =
							(await deps.transcribe({
								path: saved.path,
								mediaType: media.mimeType,
								filename: media.fileName,
							})) ?? undefined;
					} catch (err) {
						// Transcription is enrichment, not intake — a whisper
						// outage leaves the attachment path-referenced, not eaten.
						log.warn("transcription failed — attachment kept", err, {
							conversation: convId,
							file: media.fileName,
						});
					}
				}
				// Path reference plus transcript — inline-or-not is decided
				// at turn time against the model that actually runs.
				parts.push(...mediaParts(media, saved, transcript));
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
		});
	});
}

// One batch → one turn submit (plus at most one titling attempt). The
// sink is built only after the batch commits — it starts typing on
// construction. Rolling lanes route async first, so the flush returns
// a promise the buffer serializes on; a retry after a failed commit
// re-routes — the roll already left the new conversation current.
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
		// Only the app channel deletes its conversations — a missing
		// Telegram row is a store anomaly and keeps the throw+retry. A
		// deleted app conversation is a dead end, not transient: tombstone
		// the batch, or the retry hits the same missing row forever.
		if (channelOf(convId) === "app") {
			dropAppBatch(env, convId, items);
			return;
		}
		throw new Error(`flush for missing conversation: ${convId}`);
	}
	const parts = items.flatMap((i) => i.parts);
	log.debug("coalesced turn input", { conversation: convId, items: items.length });
	// A ping reply's lane IS the app conversation: the turn runs
	// headless, the DM gets a "sent to" ack, no titling to attempt.
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

// The rolling lane's async half: route, land the roll marker if one
// happened (before the turn — the operator reads it as "this is a
// fresh conversation"), then commit + submit like a topic flush.
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
		// Navigation or a scheduled fire may have moved the pin while
		// the route/marker awaited. Never admit into a cached old target.
		const current = deps.store.currentDm(chatId);
		if (current === null) throw new Error(`DM ${chatId} has no current conversation after routing`);
		if (current.id !== result.conv.id) {
			log.info("dm admission re-pinned", {
				address: laneKey,
				from: result.conv.id,
				to: current.id,
			});
		}
		admitBatch(
			env,
			current,
			laneKey,
			remaining,
			remaining.flatMap((i) => i.parts),
		);
		return;
	}
}

// Manual navigation preserves input still in intake but cancels its
// work; consult durable dispositions, not an in-memory generation.
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

// The audience note a shared chat's turns carry: one text part at the
// head of the burst, never in the frozen system prompt (cache
// stability). Guest personas already know the shape.
export const SHARED_CHAT_NOTE =
	"[note: this is a shared chat — everyone in it can read your replies. " +
	"Be deliberate before surfacing private material (workspace files, notes, past conversations).]";

export function sharedChatPart(
	conversationId: string,
	chatId: number,
	isChatOpen: (chatId: number) => boolean,
): { type: "text"; text: string } | null {
	if (channelOf(conversationId) === "guest") return null;
	if (chatId > 0) return null; // private chats: a bot member chat IS the DM
	return isChatOpen(chatId) ? { type: "text", text: SHARED_CHAT_NOTE } : null;
}

// Commit → sink → submit — the tail every lane shares after routing.
// Throws on a failed commit — the buffer retains the batch and
// retries; nothing reached Telegram, so nothing needs answering.
function admitBatch(
	env: FlushEnv,
	conv: Conversation,
	laneKey: string,
	items: BufferedItem[],
	parts: UIMessage["parts"],
): void {
	const { deps } = env;
	const tts = deps.configRef.current.tts;
	// Audience first — the note qualifies the content that follows.
	const audience = sharedChatPart(conv.id, conv.chatId, env.isChatOpen);
	const message = userMessage(audience === null ? parts : [audience, ...parts]);
	env.inbox.commitBatch(
		items.map((i) => i.updateId),
		laneKey,
		() => {
			deps.store.append(conv.id, [message]);
		},
	);
	const sink = makeDeliverySink(
		env.api,
		conv,
		items[0]?.replyTo,
		undefined,
		tts && !deps.configRef.ttsDown
			? { voiceMode: conv.voice, synthesize: (text) => deps.synthesize(text, tts) }
			: undefined,
		undefined,
		undefined,
		deps.store,
	);
	try {
		deps.runtime.submitPersisted(conv, message, sink);
	} catch (err) {
		// The batch committed — a buffer retry would hit "missing,
		// committed" forever. The sink was already constructed (typing
		// interval running) — release it or it ghosts "typing…" forever.
		log.error("turn submit failed after inbox commit", err, { conversation: conv.id });
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

// The deleted-app-conversation landing: consume the inbox rows without
// appending (a tombstone — the buffer stops retrying, the rows stop
// replaying at boot) and tell each replying chat it never landed: the
// operator is expecting a "sent to" ack, silence would lie.
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
			env.api.sendMessage(chat, "not sent — that app conversation was deleted"),
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
	// One ack per chat that replied — coalescing can merge several
	// operators' replies into one app batch. Delivery only, never history.
	for (const chat of new Set(items.map((i) => i.chatId))) {
		void withTimeout(
			env.api.sendMessage(chat, `sent to ${conv.title ?? "app conversation"}`),
			"sendMessage (ping reply ack)",
		).catch((err: unknown) => {
			// Abandoned, not cancelled — the ack may still have landed.
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
		// Same release contract as admitBatch — a constructed sink
		// must never be abandoned after a committed batch.
		log.error("turn submit failed after inbox commit", err, { conversation: conv.id });
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

// Per-conversation intake chain: media resolution is slow and grammy's
// runner is sequential, so it runs off the update hot path — a 60s
// download would stall every later update, /stop included. Chaining
// per conversation keeps buffer.push order matching arrival.
function enqueueIntake(
	intake: Map<string, Promise<void>>,
	convId: string,
	step: () => Promise<void>,
): Promise<void> {
	const prev = intake.get(convId) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(step);
	intake.set(convId, next);
	// Keep the rejection visible to replay, while avoiding an unhandled
	// rejection for the live (fire-and-forget) update path.
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
	// Queue every recovered entry before polling resumes, but never wait
	// here for a wedged copy — new updates join behind them.
	for (const entry of entries) {
		void enqueuePersisted(env, entry).catch(() => {
			// Logged by the chain; the row remains on disk for next boot.
		});
	}
	log.info("telegram inbox recovery queued", { updates: entries.length });
}

export async function createBot(deps: BotDeps): Promise<RunningBot> {
	const token = await deps.auth.resolve(AUTH_TELEGRAM_TOKEN);
	// apiRoot is structural — applies at process start, not hot-reloaded.
	const apiRoot = deps.configRef.current.telegram.apiRoot;
	const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
	// Populates bot.botInfo, needed to route /cmd@botname. Bounded: a
	// wedged connection must fail boot loudly, not hang.
	await withTimeout(bot.init(), "getMe");
	const base = {
		deps,
		api: bot.api,
		apiRoot,
		token,
		botUsername: bot.botInfo.username,
		// One auto-title attempt per topic per process — a failing
		// provider must not retry on every burst.
		titleAttempts: new Set<string>(),
	};
	const intake = new Map<string, Promise<void>>();
	const inbox = openTelegramInbox(deps.store.db);
	// The ping map shares the store's handle like the inbox; the bell
	// builds per-turn so allowedUsers and publicUrl read live config.
	const pings = openPings(deps.store.db);
	// The 👍/👎 tap record — same shared handle.
	const ratings = openRatings(deps.store.db);
	const bell = (conv: Conversation): TurnSink =>
		makeBellSink(
			{
				api: bot.api,
				store: deps.store,
				pings,
				allowedUsers: () => deps.configRef.current.allowedUsers,
				publicUrl: () => deps.configRef.current.publicUrl || undefined,
			},
			conv,
			"ping reply",
		);
	const guestStore = openGuestStore(deps.store.db);
	const isChatOpen = (chatId: number): boolean => guestStore.isOpen(chatId);
	const buffer = new CoalescingBuffer<BufferedItem>(
		QUIET_WINDOW_MS,
		(convId, items) => flushConversation({ ...base, inbox, bell, isChatOpen }, convId, items),
		COALESCE_MAX_WAIT_MS,
	);
	const env: IntakeEnv = { ...base, buffer, intake, inbox, pings, bell, isChatOpen };

	// Guest mode: both surfaces register BEFORE the access gate — the
	// gate stays pure and guest traffic never reaches it. Handlers no-op
	// without the config block, so removing it disables intake, no restart.
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
				// Log-and-continue: a guest summons is a one-shot, never worth the poller's life.
				log.error("guest handler failed", err, { update: ctx.update.update_id });
			},
		);
	});
	bot.on("message", async (ctx, next) => {
		// Labeled catch like handleGuestUpdate's above: the router runs
		// before the access gate, so without this a throw (possibly
		// after the budget was charged — admission already ran) lands
		// only in the generic bot.catch, unattributed to the guest
		// surface. Fall through to the gate on failure so normal intake
		// still gets the final say on the message.
		try {
			if (await routeMemberGuestMessage(guestEnv, ctx.message, ctx.update.update_id)) return;
		} catch (err) {
			log.error("member guest handler failed", err, { update: ctx.update.update_id });
		}
		await next();
	});

	bot.use(allowedUserGate(deps.configRef));

	bot.on("message", (ctx) => handleMessageDurably(env, ctx.message, ctx.update.update_id));

	// Edits never re-enter history — the original already is it — but
	// must leave a trace: acked and logged.
	bot.on("edited_message", (ctx) => {
		log.info("edited message acked — edits do not re-enter history", {
			chat: ctx.editedMessage.chat.id,
			message: ctx.editedMessage.message_id,
		});
	});

	bot.callbackQuery(SPEAK_CALLBACK, (ctx) => {
		void handleSpeakButton(ctx.callbackQuery, {
			api: bot.api,
			// Read per tap — a mini-app save applies without restart; the boot
			// ffmpeg gate counts as off here, /voice carries the reason.
			tts: deps.configRef.ttsDown ? undefined : deps.configRef.current.tts || undefined,
			synthesize: deps.synthesize,
		});
	});

	registerRateButton(bot, { api: bot.api, ratings });

	bot.callbackQuery(MAIL_CALLBACK_RE, (ctx) => {
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

	bot.catch((err) => {
		log.error("bot error", err.error, { update: String(err.ctx?.update?.update_id) });
		if (err.error instanceof InboxRecordError) process.exit(1);
	});

	return {
		bot,
		replayInbox: () => replayInbox(env),
		startPolling() {
			void bot.start({ onStart: () => log.info("long polling started") }).catch((err: unknown) => {
				log.error("long polling failed", err);
				process.exit(1);
			});
		},
		async drainIntake() {
			// Drain before AND after the chains: a hung media resolution
			// must not take already-buffered input down with it; what the
			// settled chains pushed goes out in the second pass. Later input
			// rides its own timer — the closed runtime records it history-only.
			try {
				await buffer.drain();
			} catch (err) {
				// Keep draining media; the failed batch remains in memory
				// and gets another attempt after those chains settle.
				log.warn("intake first drain failed — retrying after media chains", err);
			}
			await Promise.allSettled([...intake.values()]);
			await buffer.drain();
		},
	};
}

// The mini-app door is the chat menu button. Called at boot and on
// config writes, so a publicUrl change (or clearing it) applies live.
export function applyMenuButton(api: Api, publicUrl: string | undefined): void {
	const menu_button: MenuButton = publicUrl
		? { type: "web_app", text: "Settings", web_app: { url: publicUrl } }
		: { type: "default" };
	api
		.setChatMenuButton({ menu_button })
		.catch((err: unknown) => log.warn("menu button failed", err));
}

// setMyCommands persists server-side on the bot token, so the list
// must be overwritten to ever change. Cosmetic: a failure warns.
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

	// Unconditional: an unset publicUrl must reset the button to
	// default, not leave a stale web_app link.
	applyMenuButton(bot.api, deps.configRef.current.publicUrl);
	applyCommands(bot.api);

	return running;
}
