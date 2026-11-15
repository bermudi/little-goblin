// src/tg's entry point — only what callers outside this adapter use
// (src/index.ts, src/boot/telegram-attach.ts). The modules behind it —
// deps, access-gate, intake, flush, bot — are imported directly; this
// is deliberately not a blanket re-export hub (#451's agreed cut
// lines).

export { AUTH_TELEGRAM_TOKEN, type BotDeps } from "./deps.ts";
export {
	applyMenuButton,
	startBot,
	TelegramInitializationCancelled,
	type RunningBot,
} from "./bot.ts";
