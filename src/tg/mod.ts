// Telegram composition: grammy long polling, allowed-user gate first
// thing, commands → settings, everything else → coalescing buffer → turn.
// Only this directory knows grammy.

import { Bot, type Api } from "grammy";
import type { MenuButton, Message } from "grammy/types";
import type { UIMessage } from "ai";
import type { AuthStore } from "../auth.ts";
import { paths, type Config, type ConfigRef, type TtsConfig } from "../config.ts";
import type { ConversationAddress, ConversationStore } from "../conversation.ts";
import { userMessage, type Runtime } from "../runtime.ts";
import { log } from "../log.ts";
import { CoalescingBuffer } from "./buffer.ts";
import { COMMAND_RE, COMMANDS, handleCommand, type CommandMemoryDeps } from "./commands.ts";
import { withTimeout } from "./deadline.ts";
import { makeDeliverySink, SPEAK_CALLBACK } from "./delivery.ts";
import { MAIL_CALLBACK_RE, type MailApproval } from "./mail-approval.ts";
import { handleSpeakButton } from "./speak-button.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import { mediaFromMessage, mediaParts, saveAttachment } from "./media.ts";
import { openTelegramInbox, validatedInboxMedia, type InboxEntry, type InboxPayload } from "./inbox.ts";
import { maybeRenameTopic, titleMetaFromService } from "./titles.ts";

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

// Conversation identity IS the Telegram address: a topic — forum
// supergroup or bot DM with topics enabled — or the bare chat.
// `message_thread_id` also rides on comment threads in non-forum
// groups, where `is_topic_message` stays unset and bots can't post;
// those stay bare-chat. Private chats keep a thread-id fallback:
// is_topic_message coverage for DM topics is newer than the field
// itself.
export function conversationAddress(msg: {
	chat: { id: number; type: string };
	message_thread_id?: number;
	is_topic_message?: boolean;
}): ConversationAddress {
	if (
		msg.message_thread_id !== undefined &&
		(msg.is_topic_message === true || msg.chat.type === "private")
	) {
		return { kind: "topic", chatId: msg.chat.id, threadId: msg.message_thread_id };
	}
	return { kind: "dm", chatId: msg.chat.id };
}

interface BufferedItem {
	updateId: number;
	parts: UIMessage["parts"];
	replyTo: number | undefined;
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
}

export type FlushEnv = Pick<IntakeEnv, "deps" | "api" | "titleAttempts" | "inbox">;

export function handleMessage(env: IntakeEnv, msg: Message, updateId: number): void {
	const { deps } = env;
	const text = msg.text ?? msg.caption ?? "";
	const addr = conversationAddress(msg);
	const conv = deps.store.resolve(addr, paths.workspace());
	log.debug("intake", {
		updateId,
		conversation: conv.id,
		message: msg.message_id,
		...(conv.threadId !== null ? { thread: conv.threadId } : {}),
	});
	// conv is read before this patch — titleImplicit transitions both
	// ways get a line, so "why is it still New Chat" never needs a REPL.
	const topicMeta = titleMetaFromService(msg);
	if (topicMeta) {
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

	// Commands are settings-only — but a caption that looks like a
	// command must not silently eat the media it rides on; media wins.
	let media: ReturnType<typeof mediaFromMessage> = null;
	let mediaError: unknown = null;
	try {
		const extracted = mediaFromMessage(msg);
		media = extracted === null ? null : validatedInboxMedia(extracted);
	} catch (err) {
		mediaError = err;
	}
	if (text !== "" && !media && mediaError === null && COMMAND_RE.test(text)) {
		let handled = false;
		try {
			handled = handleCommand(
				{
					api: env.api,
					configRef: deps.configRef,
					store: deps.store,
					runtime: deps.runtime,
					botUsername: env.botUsername,
					...(deps.memory ? { memory: deps.memory } : {}),
				},
				conv,
				text,
			);
		} catch (err) {
			// Commands bypass the inbox entirely — a failure here is not an
			// InboxRecordError, and must not reach handleMessageDurably as
			// one. Log it, tell the operator, let grammy consume the update.
			log.error("command failed", err, { conversation: conv.id });
			env.api
				.sendMessage(
					conv.chatId,
					`command failed: ${err instanceof Error ? err.message : String(err)}`,
					conv.threadId === null ? {} : { message_thread_id: conv.threadId },
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
		log.debug("dropped message with no text or media", { conversation: conv.id });
		return;
	}

	const payload: InboxPayload = {
		conversationId: conv.id, chatId: msg.chat.id, messageId: msg.message_id,
		text, media, mediaError: mediaError === null ? null : String(mediaError),
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
	const { conversationId: convId, text, media, mediaError, messageId } = payload;
	const { deps } = env;
	return enqueueIntake(env.intake, convId, async () => {
		const parts: UIMessage["parts"] = [];
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
							(
								await deps.transcribe({
									path: saved.path,
									mediaType: media.mimeType,
									filename: media.fileName,
								})
							) ?? undefined;
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

		env.buffer.push(convId, { updateId, parts, replyTo: messageId });
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
export function flushConversation(env: FlushEnv, convId: string, items: BufferedItem[]): void {
	const { deps } = env;
	const conv = deps.store.get(convId);
	if (!conv) {
		throw new Error(`flush for missing conversation: ${convId}`);
	}
	const parts = items.flatMap((i) => i.parts);
	const replyTo = items[0]?.replyTo;
	log.debug("coalesced turn input", { conversation: convId, items: items.length });
	if (
		conv.threadId !== null &&
		conv.titleImplicit &&
		deps.configRef.current.titleModel !== undefined &&
		!env.titleAttempts.has(conv.id)
	) {
		const text = parts
			.map((p) =>
				p.type === "text" && !p.text.startsWith(ATTACHMENT_FAILED_PREFIX)
					? p.text
					: "",
			)
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
	const tts = deps.configRef.current.tts;
	const message = userMessage(parts);
	// Throws on a failed commit — the buffer retains the batch and
	// retries; nothing reached Telegram, so nothing needs answering.
	env.inbox.commitBatch(items.map((i) => i.updateId), convId, () => {
		deps.store.append(convId, [message]);
	});
	const sink = makeDeliverySink(
		env.api,
		conv,
		replyTo,
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
		log.error("turn submit failed after inbox commit", err, { conversation: convId });
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
	void next.then(() => {
		if (intake.get(convId) === next) intake.delete(convId);
	}, (err: unknown) => {
		log.error("intake step failed", err, { conversation: convId });
		if (intake.get(convId) === next) intake.delete(convId);
	});
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
	const buffer = new CoalescingBuffer<BufferedItem>(
		QUIET_WINDOW_MS,
		(convId, items) => flushConversation({ ...base, inbox }, convId, items),
		COALESCE_MAX_WAIT_MS,
	);
	const env: IntakeEnv = { ...base, buffer, intake, inbox };

	bot.use(allowedUserGate(deps.configRef));

	bot.on("message", (ctx) => handleMessageDurably(env, ctx.message, ctx.update.update_id));

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
				buffer.drain();
			} catch (err) {
				// Keep draining media; the failed batch remains in memory
				// and gets another attempt after those chains settle.
				log.warn("intake first drain failed — retrying after media chains", {
					error: String(err),
				});
			}
			await Promise.allSettled([...intake.values()]);
			buffer.drain();
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
	api.setChatMenuButton({ menu_button }).catch((err: unknown) =>
		log.warn("menu button failed", { error: String(err) }),
	);
}

// setMyCommands persists server-side on the bot token — v1's command
// list will sit there forever unless we overwrite it. Cosmetic, so a
// failure is a warn, not a boot error.
export function applyCommands(api: Api): void {
	api.setMyCommands([...COMMANDS]).catch((err: unknown) =>
		log.warn("setMyCommands failed", { error: String(err) }),
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
