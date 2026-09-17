// Telegram composition: grammy long polling, allowed-user gate first
// thing, commands → settings, everything else → coalescing buffer → turn.
// Only this directory knows grammy.

import { Bot, type Api } from "grammy";
import type { MenuButton } from "grammy/types";
import type { UIMessage } from "ai";
import type { AuthStore } from "../auth.ts";
import { paths, type Config } from "../config.ts";
import type { ConversationAddress, ConversationStore } from "../conversation.ts";
import { userMessage, type Runtime } from "../runtime.ts";
import { log } from "../log.ts";
import { CoalescingBuffer } from "./buffer.ts";
import { COMMAND_RE, handleCommand } from "./commands.ts";
import { withTimeout } from "./deadline.ts";
import { makeDeliverySink } from "./delivery.ts";
import { mediaFromMessage, mediaParts, saveAttachment } from "./media.ts";

export const AUTH_TELEGRAM_TOKEN = "telegram";
const QUIET_WINDOW_MS = 1_500;

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
	configRef: { current: Config };
	auth: AuthStore;
	store: ConversationStore;
	runtime: Runtime;
}

export async function createBot(deps: BotDeps): Promise<Bot> {
	const token = await deps.auth.resolve(AUTH_TELEGRAM_TOKEN);
	// apiRoot is structural — applies at process start, not hot-reloaded.
	const apiRoot = deps.configRef.current.telegram.apiRoot;
	const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
	// Populates bot.botInfo — needed to route /cmd@botname correctly.
	// Bounded like the other api calls: a wedged connection should fail
	// boot loudly, not hang before the "online" log line.
	await withTimeout(bot.init(), "getMe");
	const botUsername = bot.botInfo.username;
	const buffer = new CoalescingBuffer<BufferedItem>(QUIET_WINDOW_MS, (convId, items) => {
		const conv = deps.store.get(convId);
		if (!conv) {
			log.error("flush for missing conversation", undefined, { conversation: convId });
			return;
		}
		const parts = items.flatMap((i) => i.parts);
		const replyTo = items[0]?.replyTo;
		const sink = makeDeliverySink(bot.api, conv, replyTo);
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
	});

	// Per-conversation intake chain. Media resolution (getFile, download,
	// models.dev) is slow, so it runs off the update hot path — grammy's
	// runner processes updates sequentially and a 60s download would stall
	// every later update, /stop included. Chaining per conversation keeps
	// buffer.push order matching arrival order; commands bypass the chain.
	const intake = new Map<string, Promise<void>>();
	const enqueueIntake = (convId: string, step: () => Promise<void>): void => {
		const prev = intake.get(convId) ?? Promise.resolve();
		const next = prev.then(step).catch((err: unknown) => {
			log.error("intake step failed", err, { conversation: convId });
		});
		intake.set(convId, next);
		void next.finally(() => {
			if (intake.get(convId) === next) intake.delete(convId);
		});
	};

	bot.use(async (ctx, next) => {
		// Allowed-user gate, first thing. Read per-message so config
		// writes via the mini app take effect without a restart.
		if (!ctx.from) {
			// Service updates carry no sender — routine, not a warn.
			log.debug("rejected update with no sender");
			return;
		}
		if (!deps.configRef.current.allowedUsers.includes(ctx.from.id)) {
			log.warn("rejected user", { userId: ctx.from.id });
			return;
		}
		await next();
	});

	bot.on("message", (ctx) => {
		const msg = ctx.message;
		const text = msg.text ?? msg.caption ?? "";
		const addr = conversationAddress(msg);
		const conv = deps.store.resolve(addr, paths.workspace());
		const topicTitle = msg.forum_topic_created?.name ?? msg.forum_topic_edited?.name;
		if (topicTitle !== undefined) {
			deps.store.setMeta(conv.id, { title: topicTitle });
		}

		// Commands are settings-only — but a caption that looks like a
		// command must not silently eat the media it rides on; media wins.
		const media = mediaFromMessage(msg);
		if (text !== "" && !media && COMMAND_RE.test(text)) {
			if (handleCommand({ api: bot.api, configRef: deps.configRef, store: deps.store, runtime: deps.runtime, botUsername }, conv, text)) {
				return;
			}
		}

		if (text === "" && !media) {
			// Service messages, join/leave, and media kinds intake doesn't
			// cover — routine, but worth a debug line when it isn't.
			log.debug("dropped message with no text or media", { conversation: conv.id });
			return;
		}

		enqueueIntake(conv.id, async () => {
			const parts: UIMessage["parts"] = [];
			if (text !== "") parts.push({ type: "text", text });

			if (media) {
				try {
					const file = await withTimeout(bot.api.getFile(media.fileId), "getFile");
					const saved = await saveAttachment(media, file, apiRoot, token);
					// Just the saved-path reference — whether the bytes go
					// inline is decided at turn time against the model that
					// actually runs.
					parts.push(...mediaParts(media, saved));
				} catch (err) {
					log.error("media intake failed", err, { conversation: conv.id });
					parts.push({ type: "text", text: `[attachment failed to download: ${String(err)}]` });
				}
			}

			buffer.push(conv.id, { parts, replyTo: msg.message_id });
		});
	});

	bot.catch((err) => {
		log.error("bot error", err.error, { update: String(err.ctx?.update?.update_id) });
	});

	return bot;
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

export async function startBot(deps: BotDeps): Promise<Bot> {
	const bot = await createBot(deps);
	log.info("telegram bot online", { bot: bot.botInfo.username });

	// Unconditional: an unset publicUrl must reset the button to default,
	// not leave a stale web_app link from a previous config.
	applyMenuButton(bot.api, deps.configRef.current.publicUrl);

	bot.start({
		onStart: () => log.info("long polling started"),
	});
	return bot;
}
