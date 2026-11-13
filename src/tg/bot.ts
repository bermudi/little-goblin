// Bot assembly: createBot wires the whole adapter — guest handlers
// BEFORE the access gate (guests don't pass it), the gate, message/
// edited-message intake, and the five callback-query doors — plus
// startBot, menu/commands application, and the RunningBot handle.
// Middleware order here is load-bearing; this is the only module that
// imports both intake and flush (it wires the buffer's flush callback).

import { Bot, type Api } from "grammy";
import type { MenuButton } from "grammy/types";
import { paths } from "../home-layout.ts";
import type { Conversation } from "../conversation-read.ts";
import type { TurnSink } from "../turn/sink.ts";
import { log } from "../log.ts";
import { makeBellSink } from "./bell.ts";
import { CoalescingBuffer } from "./buffer.ts";
import { COMMANDS, DM_COMMANDS } from "./commands.ts";
import { withTimeout } from "./deadline.ts";
import { initializeBot } from "./init.ts";
import { floodWaitTransformer } from "./flood-wait.ts";
import { registerGenerationStop } from "./generation-stop.ts";
import {
	type GuestEnv,
	handleGuestUpdate,
	openGuestStore,
	routeMemberGuestMessage,
} from "./guest.ts";
import { MAIL_CALLBACK_RE } from "./mail-approval.ts";
import { PROGRAM_CALLBACK_RE } from "./program-approval.ts";
import { registerRateButton } from "./rate-button.ts";
import { openRatings } from "../reply-ratings.ts";
import { SKILL_CALLBACK_RE, startSkillApproval } from "./skill-approval.ts";
import {
	handleTempSkillCallback,
	skillCommandDeps,
	TEMP_SKILL_CALLBACK_RE,
} from "./skill-command.ts";
import { handleSpeakButton, SPEAK_CALLBACK } from "./speak-button.ts";
import { openTelegramInbox } from "./inbox.ts";
import { openPings } from "./pings.ts";
import { accessGate } from "./access-gate.ts";
import { AUTH_TELEGRAM_TOKEN, type BotDeps } from "./deps.ts";
import {
	type BufferedItem,
	COALESCE_MAX_WAIT_MS,
	handleEditedMessage,
	handleMessageDurably,
	InboxRecordError,
	type IntakeEnv,
	QUIET_WINDOW_MS,
	replayInbox,
} from "./intake.ts";
import { flushConversation } from "./flush.ts";

export interface RunningBot {
	bot: Bot;
	drainIntake(): Promise<void>;
	replayInbox(): Promise<void>;
	/** A terminated poll is a channel failure, not a boot failure — the
	 *  owner detaches in its callback. */
	startPolling(onError: (err: unknown) => void): void;
	/** Resolves when grammY's polling loop and its middleware have finished. */
	waitForPolling(): Promise<void>;
}

export class TelegramInitializationCancelled extends Error {}

export async function createBot(
	deps: BotDeps,
	canContinue: () => boolean = () => true,
): Promise<RunningBot> {
	const token = await deps.auth.resolve(AUTH_TELEGRAM_TOKEN);
	if (!canContinue())
		throw new TelegramInitializationCancelled(
			"telegram bot initialization cancelled after token resolution",
		);
	const apiRoot = deps.configRef.current.telegram.apiRoot;
	const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
	bot.api.config.use(floodWaitTransformer());
	await initializeBot(bot);
	if (!canContinue())
		throw new TelegramInitializationCancelled("telegram bot initialization cancelled after getMe");
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
		void handleTempSkillCallback(skillCommandDeps(deps, bot.api), {
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
		}).catch((err: unknown) => {
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

	let polling: Promise<void> = Promise.resolve();
	return {
		bot,
		replayInbox: () => replayInbox(env),
		startPolling(onError: (err: unknown) => void) {
			polling = bot
				.start({ onStart: () => log.startup("long polling started") })
				.catch((err: unknown) => {
					log.error("long polling failed", err);
					onError(err);
				});
		},
		waitForPolling: () => polling,
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

export async function startBot(
	deps: BotDeps,
	canContinue: () => boolean = () => true,
): Promise<RunningBot> {
	const running = await createBot(deps, canContinue);
	// The owner must receive and drain a created bot, even if cancellation
	// arrived between createBot returning and this continuation.
	if (!canContinue()) return running;
	const { bot } = running;
	log.info("telegram bot ready — polling after inbox replay", { bot: bot.botInfo.username });

	applyMenuButton(bot.api, deps.configRef.current.publicUrl);
	applyCommands(bot.api);

	return running;
}
