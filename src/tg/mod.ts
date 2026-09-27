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
import { handleMailApproval, MAIL_CALLBACK_RE } from "./mail-approval.ts";
import type { MailReader, MailSender } from "../mail.ts";
import type { OutboxStore } from "../mail-outbox.ts";
import { handleSpeakButton } from "./speak-button.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import { mediaFromMessage, mediaParts, saveAttachment } from "./media.ts";
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
	parts: UIMessage["parts"];
	replyTo: number | undefined;
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
	// Mail drafts' Send/Cancel buttons — absent = mail never configured
	// this run (a stale button still gets an answer, never a hang).
	mail?: {
		outbox: OutboxStore;
		sender(): MailSender | null;
		// The threading lookup at send time is a READ — it rides the
		// read credential, never the send token.
		reader(): MailReader | null;
	};
}

export interface RunningBot {
	bot: Bot;
	// Drain in-flight intake: wait out media-resolution chains, then
	// flush the coalescing buffer so buffered input submits. Shutdown
	// calls this after closing the runtime — submits then land in
	// history without starting turns. Bounded by the caller.
	drainIntake(): Promise<void>;
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
}

export type FlushEnv = Pick<IntakeEnv, "deps" | "api" | "titleAttempts">;

export function handleMessage(env: IntakeEnv, msg: Message): void {
	const { deps } = env;
	const text = msg.text ?? msg.caption ?? "";
	const addr = conversationAddress(msg);
	const conv = deps.store.resolve(addr, paths.workspace());
	log.debug("intake", {
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
	const media = mediaFromMessage(msg);
	if (text !== "" && !media && COMMAND_RE.test(text)) {
		if (
			handleCommand(
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
			)
		) {
			return;
		}
	}

	if (text === "" && !media) {
		// Service messages, join/leave, and media kinds intake doesn't
		// cover — routine, but worth a debug line when it isn't.
		log.debug("dropped message with no text or media", { conversation: conv.id });
		return;
	}

	enqueueIntake(env.intake, conv.id, async () => {
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });

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
							conversation: conv.id,
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
				log.error("media intake failed", err, { conversation: conv.id });
				parts.push({
					type: "text",
					text: `${ATTACHMENT_FAILED_PREFIX} ${String(err)}]`,
				});
			}
		}

		env.buffer.push(conv.id, { parts, replyTo: msg.message_id });
	});
}

// The coalescing-buffer flush: one batch of buffered items → one turn
// submit (plus at most one topic-titling attempt). The sink-release on
// submit failure is load-bearing — a constructed sink is already
// "typing" and ghosts forever if the submit throws past it.
export function flushConversation(env: FlushEnv, convId: string, items: BufferedItem[]): void {
	const { deps } = env;
	const conv = deps.store.get(convId);
	if (!conv) {
		log.error("flush for missing conversation", undefined, { conversation: convId });
		return;
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
		deps.runtime.submit(conv, userMessage(parts), sink);
	} catch (err) {
		// The sink was already constructed (typing interval running) —
		// release it or it ghosts "typing…" forever.
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
		throw err;
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
): void {
	const prev = intake.get(convId) ?? Promise.resolve();
	const next = prev.then(step).catch((err: unknown) => {
		log.error("intake step failed", err, { conversation: convId });
	});
	intake.set(convId, next);
	void next.finally(() => {
		if (intake.get(convId) === next) intake.delete(convId);
	});
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
	const buffer = new CoalescingBuffer<BufferedItem>(
		QUIET_WINDOW_MS,
		(convId, items) => flushConversation(base, convId, items),
		COALESCE_MAX_WAIT_MS,
	);
	const env: IntakeEnv = { ...base, buffer, intake };

	bot.use(allowedUserGate(deps.configRef));

	bot.on("message", (ctx) => handleMessage(env, ctx.message));

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
		if (!deps.mail) {
			void withTimeout(
				bot.api.answerCallbackQuery(ctx.callbackQuery.id, { text: "mail is not configured" }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
			return;
		}
		void handleMailApproval(ctx.callbackQuery, { api: bot.api, ...deps.mail });
	});

	bot.catch((err) => {
		log.error("bot error", err.error, { update: String(err.ctx?.update?.update_id) });
	});

	return {
		bot,
		async drainIntake() {
			// Drain before AND after the chains: a hung media resolution
			// must not take already-buffered input down with it, and
			// whatever the settled chains pushed goes out in the second
			// pass. Anything later still submits via its own timer —
			// the closed runtime records it history-only.
			buffer.drain();
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
	log.info("telegram bot online", { bot: bot.botInfo.username });

	// Unconditional: an unset publicUrl must reset the button to default,
	// not leave a stale web_app link from a previous config.
	applyMenuButton(bot.api, deps.configRef.current.publicUrl);
	applyCommands(bot.api);

	bot.start({
		onStart: () => log.info("long polling started"),
	});
	return running;
}
