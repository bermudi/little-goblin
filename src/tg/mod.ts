// Telegram composition: grammy long polling, allowed-user gate first
// thing, commands → settings, everything else → coalescing buffer → turn.
// Only this directory knows grammy.

import { Bot } from "grammy";
import type { UIMessage } from "ai";
import type { AuthStore } from "../auth.ts";
import { paths, type Config } from "../config.ts";
import type { ConversationAddress, ConversationStore } from "../conversation.ts";
import { userMessage, type Runtime } from "../runtime.ts";
import { log } from "../log.ts";
import { CoalescingBuffer } from "./buffer.ts";
import { COMMAND_RE, handleCommand } from "./commands.ts";
import { makeDeliverySink } from "./delivery.ts";
import { fetchFileBytes, mediaFromMessage, mediaParts, saveAttachment } from "./media.ts";

export const AUTH_TELEGRAM_TOKEN = "telegram";
const QUIET_WINDOW_MS = 1_500;

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

export function createBot(deps: BotDeps): Bot {
	const token = deps.auth.resolve(AUTH_TELEGRAM_TOKEN);
	// apiRoot is structural — applies at process start, not hot-reloaded.
	const apiRoot = deps.configRef.current.telegram.apiRoot;
	const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
	const buffer = new CoalescingBuffer<BufferedItem>(QUIET_WINDOW_MS, (convId, items) => {
		const conv = deps.store.get(convId);
		if (!conv) {
			log.error("flush for missing conversation", undefined, { conversation: convId });
			return;
		}
		const parts = items.flatMap((i) => i.parts);
		const replyTo = items[0]?.replyTo;
		deps.runtime.submit(conv, userMessage(parts), makeDeliverySink(bot.api, conv, replyTo));
	});

	bot.use(async (ctx, next) => {
		// Allowed-user gate, first thing. Read per-message so config
		// writes via the mini app take effect without a restart.
		if (!ctx.from || !deps.configRef.current.allowedUsers.includes(ctx.from.id)) {
			log.warn("rejected user", { userId: ctx.from?.id ?? "unknown" });
			return;
		}
		await next();
	});

	bot.on("message", async (ctx) => {
		const msg = ctx.message;
		const text = msg.text ?? msg.caption ?? "";
		const addr: ConversationAddress =
			msg.chat.type === "private"
				? { kind: "dm", chatId: msg.chat.id }
				: msg.message_thread_id !== undefined
					? { kind: "topic", chatId: msg.chat.id, threadId: msg.message_thread_id }
					: { kind: "dm", chatId: msg.chat.id };
		const conv = deps.store.resolve(addr, paths.workspace());
		const topicTitle = msg.forum_topic_created?.name ?? msg.forum_topic_edited?.name;
		if (topicTitle !== undefined) {
			deps.store.setMeta(conv.id, { title: topicTitle });
		}

		if (text !== "" && COMMAND_RE.test(text)) {
			if (handleCommand({ api: bot.api, configRef: deps.configRef, store: deps.store, runtime: deps.runtime }, conv, text)) {
				return;
			}
		}

		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });

		const media = mediaFromMessage(msg);
		if (media) {
			try {
				const file = await ctx.getFile();
				const bytes = await fetchFileBytes(file, apiRoot, token);
				const saved = await saveAttachment(media, bytes);
				const modelRef = conv.model ?? deps.configRef.current.model;
				parts.push(...(await mediaParts(media, bytes, saved, modelRef)));
			} catch (err) {
				log.error("media intake failed", err, { conversation: conv.id });
				parts.push({ type: "text", text: `[attachment failed to download: ${String(err)}]` });
			}
		}

		if (parts.length === 0) return; // e.g. service messages, join/leave
		buffer.push(conv.id, { parts, replyTo: msg.message_id });
	});

	bot.catch((err) => {
		log.error("bot error", err.error, { update: String(err.ctx?.update?.update_id) });
	});

	return bot;
}

export async function startBot(deps: BotDeps): Promise<Bot> {
	const bot = createBot(deps);
	const me = await bot.api.getMe();
	log.info("telegram bot online", { bot: me.username });

	if (deps.configRef.current.publicUrl) {
		// Mini-app door is the chat menu button — no /settings command needed.
		const url = deps.configRef.current.publicUrl;
		bot.api
			.setChatMenuButton({ menu_button: { type: "web_app", text: "Settings", web_app: { url } } })
			.catch((err: unknown) => log.warn("menu button failed", { error: String(err) }));
	}

	bot.start({
		onStart: () => log.info("long polling started"),
	});
	return bot;
}
