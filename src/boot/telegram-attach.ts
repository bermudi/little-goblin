// The deferred Telegram attach state machine, extracted from boot()
// (#437). Two stages: the channel's slots and their fail-closed seams
// exist before the tool factory (everything in boot binds to them and
// reads tg === null until getMe lands), and the init task kicks only
// after every core service stands — the app channel, HTTP, the scheduler
// and the mail watcher must never wait on bot auth.
//
// Invariants this module owns:
// - Ownership ≠ routability: telegramRunning survives detach; shutdown
//   still drains a detached channel's intake.
// - Interrupted-turn DMs are once per boot — the retry loop can re-run
//   the post-attach steps, but operators get one copy.
// - Replay before polling — the offset must not advance past journaled
//   input — then a detach-on-end poll contract: a terminated long poll
//   degrades the channel, never the boot.
// - The seal beats the retry sleep — a shutdown never waits out a
//   pending backoff.
// - The config-disable latch registers before HTTP can accept a save and
//   is latched for this attach only: a later enable cannot erase it.

import { makePrivateSender } from "../agent/tools/program.ts";
import { synthesizeSpeech } from "../agent/tts.ts";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import { observeConfigWrites } from "../config.ts";
import type { ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { MailApproval, MailApprovalLane } from "../mail-approval.ts";
import { unavailableMailLane } from "../mail-approval.ts";
import type { MemorySurfaces } from "../memory/mod.ts";
import type { ProgramsStore } from "../programs.ts";
import type { ProgramApproval } from "../program-approval.ts";
import type { Runtime } from "../runtime.ts";
import type { System1Client } from "../system1.ts";
import { makeBotCleanup } from "../tg/cleanup.ts";
import { withTimeout } from "../tg/deadline.ts";
import { makeTelegramMailLane, startTelegramMailApproval } from "../tg/mail-approval.ts";
import {
	type BotDeps,
	AUTH_TELEGRAM_TOKEN,
	TelegramInitializationCancelled,
	type RunningBot,
	startBot,
} from "../tg/mod.ts";
import { postProgramApproval, startTelegramProgramApproval } from "../tg/program-approval.ts";
import { sendInterruptedTurnNotices, sendStrandedInputNotices } from "../tg/turn-notice.ts";
import type { WakeApi } from "../tg/wake.ts";
import type { TurnJournal } from "../turn-journal.ts";
import type { ResumeOps } from "../turn-resume.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Attach retries back off toward the cap — the observed boot miss is a
// wallet or resolver still coming up, which heals in seconds. A
// genuinely broken credential stays loud at the cap rather than dying
// silent for the whole boot.
const TELEGRAM_ATTACH_RETRY_STEPS_MS = [5_000, 15_000, 30_000, 60_000];
const TELEGRAM_ATTACH_RETRY_CAP_MS = 300_000;
const attachRetryMs = (attempt: number) =>
	TELEGRAM_ATTACH_RETRY_STEPS_MS[attempt - 1] ?? TELEGRAM_ATTACH_RETRY_CAP_MS;

export interface TelegramAttachDeps {
	telegramEnabled: boolean;
	configRef: ConfigRef;
}

/** Everything the init task needs — all of it stands before start(). */
export interface TelegramAttachStart {
	auth: AuthStore;
	store: ConversationStore;
	runtime: Runtime;
	journal: TurnJournal;
	titleFor: BotDeps["titleFor"];
	transcribe: BotDeps["transcribe"];
	/** Memory command surfaces — absent when the memory block is off. */
	memory: MemorySurfaces | null;
	gate: System1Client | null;
	resumeOps(): ResumeOps | undefined;
	mailApproval(): MailApproval | undefined;
	programApproval(): ProgramApproval | undefined;
	programs: ProgramsStore;
	/** The shared mail lanes — attach swaps the telegram lane in, detach
	 *  restores the unavailable lane. */
	mailLanes: { telegram: MailApprovalLane };
	rewireWake(api: WakeApi): void;
	/** scheduler.tick() — catch up occurrences held while unattached. */
	tick(): void;
}

export interface TelegramAttach {
	/** The one operator-DM lane — the program tool's hook rotation and the
	 *  proposal approval's grant-time hook delivery share it (a secret URL
	 *  never enters history). Undefined when the channel is disabled at
	 *  boot; an enabled-but-unattached channel throws at call time —
	 *  never a silent skip. */
	sendPrivate: ((text: string) => Promise<void>) | undefined;
	/** The live attached api — null while detached or disabled. */
	api(): WakeApi;
	/** Fail-closed mini-app auth seam — until the channel attaches,
	 *  initData has no token to validate against and refuses. */
	botToken(): string | undefined;
	/** Joins in-flight Telegram approval taps — reads the adapter slot
	 *  live so joins never race a post-boot detach. */
	stopProgramApproval(): Promise<void>;
	/** Kick the deferred init task — exactly once, after HTTP, the
	 *  scheduler and the mail watcher stand. */
	start(deps: TelegramAttachStart): void;
	/** Shutdown's telegram stop: seals the attach path first (a late getMe
	 *  can no longer bind), detaches routing, stops polling only if it is
	 *  actually running, drains intake, and joins the init task — all
	 *  under the caller's shared drain budget, never its own timer. */
	stop(): Promise<void>;
}

export function openTelegramAttach(deps: TelegramAttachDeps): TelegramAttach {
	const { telegramEnabled, configRef } = deps;
	// Routing slot: null until an attach lands, null again on detach —
	// every seam below reads it live.
	let tg: RunningBot | null = null;
	// Stop/drain ownership is separate from routability: a detached
	// channel still owns intake that shutdown must drain.
	let telegramRunning: RunningBot | null = null;
	// The init task reads this after each await — a getMe landing during
	// shutdown must not attach or start polling.
	let telegramSealed = false;
	// Interrupted-turn DMs are once per boot: the attach retry loop can
	// re-run the post-attach steps, but operators get one copy.
	let interruptedNoticesSent = false;
	// Resolved by stopTelegram — the attach retry's backoff races it, so a
	// shutdown never waits out a pending retry.
	let fireTelegramSeal!: () => void;
	const telegramSealSignal = new Promise<void>((resolve) => {
		fireTelegramSeal = resolve;
	});
	// Resolved inside the Telegram init task only; the HTTP bot-token
	// getter fails closed until the channel attaches.
	let telegramToken: string | undefined;
	// The Telegram adapters of the shared approval owners — swapped in on
	// attach, dropped on detach.
	let telegramMailApproval: ReturnType<typeof startTelegramMailApproval> | undefined;
	let telegramProgramApproval: ReturnType<typeof startTelegramProgramApproval> | undefined;
	// A disable is latched for this attach only: a later enable cannot
	// erase it, and the observer is removed once polling starts (or the
	// attempt ends). Registered at open, before HTTP can accept a save —
	// a save can arrive the moment HTTP listens.
	let telegramAttachDisabled = false;
	const telegramDisableSignal = Promise.withResolvers<void>();
	const stopObservingTelegramConfig = telegramEnabled
		? observeConfigWrites((written) => {
				if (!written.telegram.enabled && !telegramAttachDisabled) {
					telegramAttachDisabled = true;
					telegramDisableSignal.resolve();
				}
			})
		: () => {};
	// Detach routing is bound by start() with the delivery seams; until
	// then nothing can be attached, so the no-op is unreachable.
	let detachTelegram: () => void = () => {};
	// The bot's stop/drain contract is start-free — it exists from open.
	const cleanupBot = makeBotCleanup();
	let telegramInit: Promise<void> = Promise.resolve();

	const sendPrivate = telegramEnabled
		? makePrivateSender(
				(id, text) => {
					if (tg === null) throw new Error("telegram channel is unavailable");
					return withTimeout(tg.bot.api.sendMessage(id, text), "sendMessage");
				},
				() => configRef.current.operators,
			)
		: undefined;

	const stopTelegram = (): Promise<void> => {
		telegramSealed = true;
		fireTelegramSeal();
		// Owner, not router: a detached channel still has intake to drain.
		const running = telegramRunning;
		if (tg !== null) detachTelegram();
		const cleanup = running === null ? Promise.resolve() : cleanupBot(running);
		const joined = Promise.allSettled([cleanup, telegramInit]);
		return joined.then((results) => {
			const labels = ["telegram bot cleanup", "telegram init join"];
			for (const [i, r] of results.entries()) {
				if (r.status === "rejected") {
					log.warn("shutdown step failed", r.reason, { step: labels[i] });
				}
			}
		});
	};

	return {
		sendPrivate,
		api: () => (tg === null ? null : tg.bot.api),
		botToken: () => (tg === null ? undefined : telegramToken),
		stopProgramApproval: () => telegramProgramApproval?.stop() ?? Promise.resolve(),
		start(startDeps: TelegramAttachStart): void {
			const attachTelegram = (running: RunningBot): void => {
				startDeps.mailLanes.telegram = makeTelegramMailLane(running.bot.api);
				const mail = startDeps.mailApproval();
				if (mail !== undefined) {
					telegramMailApproval = startTelegramMailApproval({
						api: running.bot.api,
						approval: mail,
					});
				}
				const program = startDeps.programApproval();
				if (program !== undefined && sendPrivate !== undefined) {
					telegramProgramApproval = startTelegramProgramApproval({
						api: running.bot.api,
						approval: program,
						programs: startDeps.programs,
						sendPrivate,
					});
				}
				startDeps.rewireWake(running.bot.api);
				tg = running;
				log.info("telegram channel attached", { bot: running.bot.botInfo.username });
			};
			detachTelegram = (): void => {
				tg = null;
				telegramMailApproval = undefined;
				telegramProgramApproval = undefined;
				startDeps.mailLanes.telegram = unavailableMailLane("telegram channel unavailable");
				startDeps.rewireWake(null);
				// telegramRunning stays — its intake still belongs to this boot and
				// shutdown drains it even while routing reads detached.
			};
			const canAttachTelegram = (): boolean => {
				if (telegramSealed || !startDeps.runtime.accepting()) {
					log.info("telegram attach skipped — shutdown in progress");
					return false;
				}
				if (telegramAttachDisabled || !configRef.current.telegram.enabled) {
					log.info("telegram attach stopped — channel disabled in config");
					return false;
				}
				return true;
			};
			telegramInit = (async () => {
				for (let attempt = 1; ; attempt++) {
					if (!canAttachTelegram()) return;
					try {
						// The token resolves inside this task only — the HTTP door
						// fails closed until the attach below sets it live.
						telegramToken = await startDeps.auth.resolve(AUTH_TELEGRAM_TOKEN);
						if (!canAttachTelegram()) return;
						const running = await startBot(
							{
								configRef,
								auth: startDeps.auth,
								store: startDeps.store,
								runtime: startDeps.runtime,
								titleFor: startDeps.titleFor,
								async synthesize(text, tts) {
									return synthesizeSpeech(text, tts, { auth: startDeps.auth });
								},
								transcribe: startDeps.transcribe,
								...(startDeps.memory ? { memory: { ...startDeps.memory } } : {}),
								mail: () => telegramMailApproval,
								programApproval: () => telegramProgramApproval,
								followUpGate: () => startDeps.gate ?? undefined,
								resumeOps: startDeps.resumeOps,
							},
							canAttachTelegram,
						);
						// Own the bot the moment it exists — a later detach or a
						// seal mid-replay must never strand its stop/drain.
						telegramRunning = running;
						if (!canAttachTelegram()) {
							await cleanupBot(running);
							return;
						}
						attachTelegram(running);
						// Rows reclassified 'interrupted' at open get one DM per
						// operator — terse facts, never a replay. Sent only after a
						// successful attach; the skip/failure logs above stand alone.
						if (!interruptedNoticesSent) {
							interruptedNoticesSent = true;
							sendInterruptedTurnNotices(
								running.bot.api,
								startDeps.journal.interruptedAtOpen,
								configRef.current.operators,
								(id) => startDeps.store.get(id)?.title ?? undefined,
							);
							sendStrandedInputNotices(
								running.bot.api,
								startDeps.journal.strandedAtOpen,
								configRef.current.operators,
								(id) => startDeps.store.get(id)?.title ?? undefined,
							);
						}
						if (!canAttachTelegram()) {
							detachTelegram();
							await cleanupBot(running);
							return;
						}
						// Replay before polling — the offset must not advance past
						// journaled input — then poll with a detach-on-end contract:
						// a terminated long poll degrades the channel, never the boot.
						await running.replayInbox();
						if (!canAttachTelegram()) {
							detachTelegram();
							await cleanupBot(running);
							return;
						}
						running.startPolling((err) => {
							log.error(
								"telegram polling ended — channel detached; repair and restart to reattach",
								err,
							);
							detachTelegram();
						});
						// Catch up any occurrence held while the channel was
						// unattached — after replay, before steady-state polling.
						startDeps.tick();
						return;
					} catch (err) {
						// A partial attempt can own a live poller or buffered
						// intake — supersede it before the next try, or the two
						// getUpdates consumers fight over the token (409).
						const superseded = telegramRunning;
						detachTelegram();
						if (superseded !== null) {
							// Keep ownership on failure: overlapping pollers or intake are unsafe.
							try {
								await cleanupBot(superseded);
							} catch (cleanupError) {
								log.error("telegram attach failed before cleanup", err, { attempt });
								throw new Error("telegram attach cleanup failed — retry stopped", {
									cause: cleanupError,
								});
							}
							telegramRunning = null;
						}
						if (!canAttachTelegram()) {
							if (!(err instanceof TelegramInitializationCancelled)) {
								log.warn("telegram attach failed while stopping", err, { attempt });
							}
							return;
						}
						const retryMs = attachRetryMs(attempt);
						// Loud on the first failure, a warn each retry after.
						if (attempt === 1) {
							log.error("telegram attach failed — retrying", err, { attempt, retryMs });
						} else {
							log.warn("telegram attach failed — retrying", err, { attempt, retryMs });
						}
						await Promise.race([sleep(retryMs), telegramSealSignal, telegramDisableSignal.promise]);
					}
				}
			})()
				.catch((err: unknown) => {
					log.error("telegram init task failed", err);
					detachTelegram();
				})
				.finally(stopObservingTelegramConfig);
		},
		stop: stopTelegram,
	};
}
