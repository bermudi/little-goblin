// The dispatcher is built after the runtime. Its pumps stay held until boot
// calls dispatcher.start() after runtime.mount().

import { synthesizeSpeech } from "../agent/tts.ts";
import type { AppPush } from "../app-push.ts";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import type { TtsConfig } from "../config-schema.ts";
import type { ConversationStore } from "../conversation.ts";
import type { ProgramsStore } from "../programs.ts";
import type { Runtime } from "../runtime.ts";
import type { SchedulerDeps } from "../scheduler.ts";
import type { System1Client } from "../system1.ts";
import { openPings } from "../tg/pings.ts";
import { makeWakeDeps, type WakeApi } from "../tg/wake.ts";
import type { TurnJournal } from "../turn-journal.ts";
import { sinkFor, type WakeDeps } from "../wake.ts";
import { makeWakeDispatcher, type WakeDispatcher } from "../wake-dispatcher.ts";
import type { WakeStore } from "../wake-store.ts";

export interface DeliveryDeps {
	store: ConversationStore;
	runtime: Runtime;
	journal: TurnJournal;
	wakes: WakeStore;
	configRef: ConfigRef;
	auth: AuthStore;
	push: AppPush;
	/** The System One gate: the wake follow-up gate, and (fail-open,
	 *  unscored absent) the watcher-event scorer on the firing deps. */
	gate: System1Client | null;
	programs: ProgramsStore;
}

/** The wake path once its dispatcher is built. */
export interface Delivery {
	/** One wakeDeps OBJECT identity for the process: the telegram init
	 *  task mutates it in place on attach/detach so the scheduler,
	 *  delegation lifecycle and resume sinks all read the
	 *  same delivery surface at call time. Never spread it — a spread
	 *  snapshots delivery/bell before the telegram attach ever lands. */
	wakeDeps: WakeDeps;
	rewireWake(api: WakeApi): void;
	dispatcher: WakeDispatcher;
	/** The scheduler's firing deps — laid onto wakeDeps by
	 *  Object.assign, riding the same identity. */
	firingDeps: SchedulerDeps;
}

export function wireDelivery(deps: DeliveryDeps): Delivery {
	// The shared wake path — program fires and delegation notices
	// submit through it; wake.ts owns the routing. Intake opens its
	// own pings handle inside createBot.
	const pings = openPings(deps.store.db);
	const wakeBase = {
		store: deps.store,
		runtime: deps.runtime,
		configRef: deps.configRef,
		synthesize: (text: string, tts: TtsConfig) =>
			synthesizeSpeech(text, tts, { auth: deps.auth }),
		followUpGate: () => deps.gate ?? undefined,
		pings,
		push: deps.push,
	};
	const wakeDeps = makeWakeDeps({ ...wakeBase, api: null });
	// Object.assign alone can't drop absent fields — delete the
	// telegram-only seams before laying the (re)built set down, so
	// detach restores the app-only bell rather than a stale delivery.
	const rewireWake = (api: WakeApi): void => {
		delete wakeDeps.delivery;
		delete wakeDeps.markRoll;
		Object.assign(wakeDeps, makeWakeDeps({ ...wakeBase, api }));
	};

	// Durable wake delivery — the dispatcher owns record→commit→submit
	// and the journal-run ownership the runtime announces through its
	// mounted hooks. Built after wakeDeps (the sinks it uses) and
	// before replayInbox: recovered wakes enter their lanes ahead of
	// inbound traffic. The boot pump replays the last crash boundary.
	const built = makeWakeDispatcher({
		store: deps.store,
		wakes: deps.wakes,
		journal: deps.journal,
		runtime: deps.runtime,
		sinkFor: (conv) => sinkFor(wakeDeps, conv),
		deferStart: true,
	});
	// The scheduler rides the SAME wakeDeps object — a spread here
	// would snapshot delivery/bell before the telegram attach lands.
	const firingDeps: SchedulerDeps = Object.assign(wakeDeps, {
		programs: deps.programs,
		// The System One gate doubles as the watcher-event scorer
		// (fail-open) — unscored absent.
		...(deps.gate ? { checkMail: deps.gate as Pick<System1Client, "decide"> } : {}),
	});

	return {
		wakeDeps,
		rewireWake,
		dispatcher: built,
		firingDeps,
	};
}
