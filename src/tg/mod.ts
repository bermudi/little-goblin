// Telegram composition: grammy long polling, allowed-user gate first
// thing, commands → settings/navigation, everything else → buffer → turn.
// Only this directory knows grammy.

import { Bot, type Api } from "grammy";
import { z } from "zod";
import type { MenuButton, Message } from "grammy/types";
import type { UIMessage } from "ai";
import type { AuthStore } from "../auth.ts";
import { paths, type Config, type ConfigRef, type TtsConfig } from "../config.ts";
import {
	addressId,
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
// 500ms of quiet seals a burst — measured, not vibes (2026-09-25): a
// 7-chunk pasted message arrived with a 167ms worst gap, which is not
// client send pacing but one long-poll round-trip to the Telegram API
// (~185ms from this box) — a chunk straddling a poll boundary waits out
// an RTT. 200ms is falsified by that one paste; 500ms is 3× the
// observed worst and survives an RTT doubling. The window is also a
// flat latency tax on every single-message turn (no typing indicator
// until flush), so shorter-is-better within that margin. 200–300ms
// becomes safe only when polling goes LAN-side (self-hosted bot-api);
// until then RTT-sized gaps are structural, no client speed fixes them.
const QUIET_WINDOW_MS = 500;
// A source dribbling messages faster than the quiet window must not
// postpone its turn forever — the ceiling flushes mid-dribble instead.
const COALESCE_MAX_WAIT_MS = 10_000;
// Sentinel for media that failed intake — kept out of topic-title input
// or a download error becomes the conversation's name.
const ATTACHMENT_FAILED_PREFIX = "[attachment failed to download:";

// Conversation identity IS the Telegram address: a forum-supergroup
// topic or the bare chat. `message_thread_id` also rides on comment
// threads in non-forum groups, where `is_topic_message` stays unset and
// bots can't post; those stay bare-chat. Private chats always address
// the rolling DM lane — DM topics are retired (design/telegram.md →
// Rolling DM).
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
	// The chat the message arrived in — an app lane needs it to ack
	// the ping reply ("sent to <title>") since the conversation's own
	// chat_id is the 0 filler (Spin-off).
	chatId: number;
	parts: UIMessage["parts"];
	replyTo: number | undefined;
	// Set when the message quoted another (msg.reply_to_message): the
	// quoted id + its text (head-cut). Presence alone counts the item
	// as a reply for rolling-DM routing — an empty quote still joins.
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
	// Speech → text for transcribable media (voice and video notes —
	// attached audio files are data, the transcribe tool handles those
	// on demand). null = unconfigured, over the provider cap, or no
	// speech found.
	transcribe(file: SpeechFile): Promise<string | null>;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
	// Long-term memory wiring for /memory + /forget — absent = disabled.
	memory?: CommandMemoryDeps;
	// The mail approval gate — taps resolve it per-tap through this
	// getter (it's constructed right after the bot: it needs bot.api).
	// Absent = mail never wired this run — a stale button still gets
	// an answer, never a hang.
	mail?: () => MailApproval;
	// The follow-up check for Rolling DM — the reviewer's JevClient,
	// resolved per call because it is constructed after the bot in the
	// composition root. Absent = no check available: a past-gap burst
	// joins the current conversation.
	followUpGate?: () => Pick<JevClient, "decide"> | undefined;
}

export interface RunningBot {
	bot: Bot;
	// Drain in-flight intake: wait out media-resolution chains, then
	// flush the coalescing buffer so buffered input submits. Shutdown
	// calls this after closing the runtime — submits then land in
	// history without starting turns. Bounded by the caller.
	drainIntake(): Promise<void>;
	replayInbox(): Promise<void>;
	startPolling(): void;
}

// The access-control boundary: allowedUsers gates every update first
// thing, read per-message so mini-app saves apply without a restart.
// Extracted from createBot so the boundary itself is testable without
// a live bot.
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
// The message router and the coalescing flush, lifted out of createBot
// (they used to be anonymous closures) so every rule they carry is
// testable without a live bot: command-vs-media precedence, the failed
// attachment sentinel, one-attempt topic titling, the topic-meta patch
// logging, and the submit-failure sink release. createBot only wires
// grammy to these.

// Everything the lifted functions need, made explicit — the deps they
// used to close over.
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
	// The ping→conversation map (Spin-off): a swipe-reply to a
	// delegation ping routes into the app conversation that rang.
	pings: PingStore;
	// The headless sink app-lane turns submit with — the ping reply's
	// turn rings Telegram when it lands (Spin-off → Background turns).
	bell(conv: Conversation): TurnSink;
	// Guest mode: is this chat open to third-party summonses? Injected
	// per burst so the model knows its audience — the system prompt is
	// frozen per conversation (cache stability) while openness changes
	// with /open and /off.
	isChatOpen: (chatId: number) => boolean;
}

export type FlushEnv = Pick<
	IntakeEnv,
	"deps" | "api" | "titleAttempts" | "inbox" | "bell" | "isChatOpen"
>;

// The RollDeps the intake paths share — assembled per call so a
// mini-app save (dmGapMinutes) and the late-built reviewer's gate both
// read live instead of whatever was wired at boot.
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
	const text = msg.text ?? msg.caption ?? "";
	const addr = conversationAddress(msg);
	// A private chat's lane is the rolling address — the payload carries
	// the lane key and the concrete dm:<chat>:<n> conversation is routed
	// at flush (Rolling DM). Every other lane IS its conversation id, so
	// those still resolve eagerly here.
	const rolling = msg.chat.type === "private" && addr.kind === "dm" && isRollingChat(addr.chatId);
	const lane = addressId(addr);
	log.debug("intake", {
		updateId,
		conversation: lane,
		message: msg.message_id,
		...(addr.kind === "topic" ? { thread: addr.threadId } : {}),
	});
	// Media wins over slash-looking captions. Parse command ownership
	// before any conversation creation or routing, including other-bot
	// commands that are not in our advertised menu.
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
	// conv is read before this patch — titleImplicit transitions both
	// ways get a line, so "why is it still New Chat" never needs a REPL.
	// Topic service meta only exists on non-private lanes.
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
			env.api
				.sendMessage(
					target?.chatId ?? msg.chat.id,
					`command failed: ${err instanceof Error ? err.message : String(err)}`,
					target == null || target.threadId === null ? {} : { message_thread_id: target.threadId },
				)
				.catch((e: unknown) => {
					log.warn("command failure reply failed", { error: String(e) });
				});
			return;
		}
		if (handled) return;
	}

	if (text === "" && !media && mediaError === null) {
		// Service messages, join/leave, and media kinds intake doesn't
		// cover — routine, but worth a debug line when it isn't.
		log.debug("dropped message with no text or media", { conversation: lane });
		return;
	}

	const replyTo = msg.reply_to_message;
	// Telegram reports the topic's root service message as
	// reply_to_message on every ordinary message inside a forum topic
	// (and in a private chat while its threaded mode is on) — either
	// flagged forum_topic_created or, for the flagless variant, the
	// reply target IS the thread's root message. That is thread
	// plumbing, not an operator reply: counting it would route every
	// burst as "reply" and the follow-up check would never run.
	const quotedReply =
		replyTo === undefined ||
		replyTo.forum_topic_created !== undefined ||
		(msg.message_thread_id !== undefined && replyTo.message_id === msg.message_thread_id)
			? undefined
			: replyTo;
	// A swipe-reply to a delegation ping routes into the app
	// conversation that rang (Spin-off): the lane IS that conversation
	// id and the payload carries no quoted part — the app conversation
	// doesn't need the ping text. A deleted target degrades to an
	// ordinary reply, routed like any other.
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
		// The quoted context leads the message (Rolling DM): it reads as
		// the operator's own "about this" prefix, and presence counts the
		// item as a reply for routing even when the quote carried no text.
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
						log.warn("transcription failed — attachment kept", {
							conversation: convId,
							file: media.fileName,
							error: String(err),
						});
					}
				}
				// The saved-path reference (plus any transcript) — whether
				// the bytes go inline is decided at turn time against the
				// model that actually runs.
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

// The coalescing-buffer flush: one batch of buffered items → one turn
// submit (plus at most one topic-titling attempt). The sink is built
// only after the batch commits — it starts typing on construction, so
// a failed commit would otherwise send a "⚠" bubble per buffer retry
// while the store is down. And the sink-release on submit failure is
// load-bearing: a constructed sink ghosts "typing…" forever if the
// submit throws past it, but the committed batch cannot be retried
// (the rows are already consumed), so the failure is logged, answered
// once through the sink's error path, and never rethrown.
//
// Rolling-DM lanes (dm:<positive chat>) route asynchronously first —
// a quoted reply joins without a check, a plain burst past the gap asks
// the follow-up check — so the flush returns a promise the buffer
// serializes on. A retry after a failed commit simply re-routes: a roll
// that already happened left the new conversation current with fresh
// activity, so the retry joins it — no double roll.
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
		// Only the app channel deletes its conversations (the operator's
		// DELETE) — a missing Telegram row is a store anomaly and keeps
		// the throw+retry. A deleted app conversation is a dead end, not
		// a transient failure: per the Spin-off ruling (design/app.md —
		// a deleted conversation drops with a warning), tombstone the
		// batch — a retry would hit the same missing row every 5 minutes
		// forever, and the pending inbox rows replay at every boot.
		if (channelOf(convId) === "app") {
			dropAppBatch(env, convId, items);
			return;
		}
		throw new Error(`flush for missing conversation: ${convId}`);
	}
	const parts = items.flatMap((i) => i.parts);
	log.debug("coalesced turn input", { conversation: convId, items: items.length });
	// A ping reply's lane IS the app conversation — the turn runs
	// headless (the bell rings when it lands), the DM gets a "sent
	// to" ack, and no topic titling exists to attempt (Spin-off).
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

// The rolling lane's async half: route, mark the boundary if one
// happened (the marker must land before the turn — the operator reads
// it as "this is a fresh conversation"), then commit + submit into the
// routed conversation exactly like a topic flush.
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

// Manual navigation preserves input still in intake, but cancels its
// work. Consult durable dispositions, not only an in-memory generation:
// held attachments, retained batches and boot recovery all use this path.
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

// The audience note a shared chat's turns carry (Guest mode): one
// text part at the head of the burst, never in the frozen system
// prompt. Guest conversations don't need it — their persona already
// knows the shape.
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
	// Audience first (Guest mode): the note leads the burst so the
	// model reads it before the content it qualifies.
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

// The app lane's tail (Spin-off → Telegram rings): the ping reply
// commits like any batch, the DM gets a delivery-only "sent to"
// ack (never history — the ping already shows what it answers), and
// the turn submits headless — the bell rings back when it lands.
// A ping reply whose app conversation was deleted: consume the inbox
// rows without appending — a tombstone, so the buffer stops retrying
// and the rows stop replaying at every boot — and tell each replying
// chat it never landed. The operator swiped-reply expecting an "sent
// to" ack; silence would be a lie by omission.
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
			log.warn("ping reply drop ack failed", {
				chat,
				conversation: convId,
				error: String(err),
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
	// One ack per chat that replied — coalescing can merge replies
	// from several operators into the same app batch. Delivery only,
	// never history.
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
			log.warn("ping reply ack failed", {
				chat,
				conversation: conv.id,
				error: String(err),
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

// Per-conversation intake chain. Media resolution (getFile, download,
// models.dev) is slow, so it runs off the update hot path — grammy's
// runner processes updates sequentially and a 60s download would stall
// every later update, /stop included. Chaining per conversation keeps
// buffer.push order matching arrival order; commands bypass the chain.
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
	// here for a wedged local file copy. New updates join the same
	// per-conversation chain behind their recovered predecessors.
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
	// Populates bot.botInfo — needed to route /cmd@botname correctly.
	// Bounded like the other api calls: a wedged connection should fail
	// boot loudly, not hang before the "online" log line.
	await withTimeout(bot.init(), "getMe");
	const base = {
		deps,
		api: bot.api,
		apiRoot,
		token,
		botUsername: bot.botInfo.username,
		// One auto-title attempt per topic per process — a failing
		// provider must not retry on every burst. The flag survives for
		// the next boot.
		titleAttempts: new Set<string>(),
	};
	const intake = new Map<string, Promise<void>>();
	const inbox = openTelegramInbox(deps.store.db);
	// The ping→conversation map shares the store's handle like the
	// inbox (Spin-off), and the bell builds per-turn so allowedUsers
	// and publicUrl read live config.
	const pings = openPings(deps.store.db);
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

	// Guest mode (design/telegram.md → Guest mode): both surfaces
	// register BEFORE the access gate — the gate stays pure and guest
	// traffic (which includes strangers once the BotFather usage
	// restriction is off) never reaches it. Handlers no-op per update
	// when the config block is absent, so removing it disables guest
	// intake without a restart.
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
				// Handler failures are log-and-continue: a guest summons is a
				// one-shot, never worth the poller's life.
				log.error("guest handler failed", err, { update: ctx.update.update_id });
			},
		);
	});
	bot.on("message", async (ctx, next) => {
		if (await routeMemberGuestMessage(guestEnv, ctx.message, ctx.update.update_id)) return;
		await next();
	});

	bot.use(allowedUserGate(deps.configRef));

	bot.on("message", (ctx) => handleMessageDurably(env, ctx.message, ctx.update.update_id));

	// Edits carry no new content for the model — the original is already
	// history — but the operator's edit must not vanish without a trace:
	// a screenshot of "nothing happened" plus the log has to explain it
	// (audit #18). Acked, logged, never re-entered.
	bot.on("edited_message", (ctx) => {
		log.info("edited message acked — edits do not re-enter history", {
			chat: ctx.editedMessage.chat.id,
			message: ctx.editedMessage.message_id,
		});
	});

	bot.callbackQuery(SPEAK_CALLBACK, (ctx) => {
		void handleSpeakButton(ctx.callbackQuery, {
			api: bot.api,
			// Read per tap — a mini-app save applies without restart. The
			// boot ffmpeg gate counts as off here; the toast rounds, the
			// log and /voice carry the reason.
			tts: deps.configRef.ttsDown ? undefined : deps.configRef.current.tts || undefined,
			synthesize: deps.synthesize,
		});
	});

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
			// must not take already-buffered input down with it, and
			// whatever the settled chains pushed goes out in the second
			// pass. Anything later still submits via its own timer —
			// the closed runtime records it history-only.
			try {
				await buffer.drain();
			} catch (err) {
				// Keep draining media; the failed batch remains in memory
				// and gets another attempt after those chains settle.
				log.warn("intake first drain failed — retrying after media chains", {
					error: String(err),
				});
			}
			await Promise.allSettled([...intake.values()]);
			await buffer.drain();
		},
	};
}

// The mini-app door is the chat menu button — no /settings command needed.
// Called at boot and again on config writes, so a publicUrl change (or
// clearing it) takes effect without a restart.
export function applyMenuButton(api: Api, publicUrl: string | undefined): void {
	const menu_button: MenuButton = publicUrl
		? { type: "web_app", text: "Settings", web_app: { url: publicUrl } }
		: { type: "default" };
	api
		.setChatMenuButton({ menu_button })
		.catch((err: unknown) => log.warn("menu button failed", { error: String(err) }));
}

// setMyCommands persists server-side on the bot token — v1's command
// list will sit there forever unless we overwrite it. Cosmetic, so a
// failure is a warn, not a boot error.
export function applyCommands(api: Api): void {
	api
		.setMyCommands([...COMMANDS])
		.catch((err: unknown) => log.warn("setMyCommands failed", { error: String(err) }));
	api
		.setMyCommands([...DM_COMMANDS], { scope: { type: "all_private_chats" } })
		.catch((err: unknown) =>
			log.warn("setMyCommands private scope failed", { error: String(err) }),
		);
}

export async function startBot(deps: BotDeps): Promise<RunningBot> {
	const running = await createBot(deps);
	const { bot } = running;
	log.info("telegram bot ready — polling after inbox replay", { bot: bot.botInfo.username });

	// Unconditional: an unset publicUrl must reset the button to default,
	// not leave a stale web_app link from a previous config.
	applyMenuButton(bot.api, deps.configRef.current.publicUrl);
	applyCommands(bot.api);

	return running;
}
