import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { ensureModelsDevCatalog, ensureOpenRouterCatalog } from "./agent/models-dev.ts";
import { generateNoteRewrite } from "./agent/note-rewrite.ts";
import { makeStepBuilder } from "./agent/step.ts";
import { makeTitleFor } from "./agent/title.ts";
import { makeTurnTools as makeTurnToolsFactory } from "./agent/turn-tools.ts";
import { makePrivateSender } from "./agent/tools/program.ts";
import { checkBootMedia, makeTranscriber } from "./agent/transcribe.ts";
import { makeVisionDepsFor } from "./agent/vision.ts";
import { makeSpeaker, synthesizeSpeech } from "./agent/tts.ts";
import { appendAuthRecord, loadAuth } from "./auth.ts";
import { openAppPush } from "./app-push.ts";
import { openCacheObservation } from "./cache-observation.ts";
import { openWindowCapture } from "./window-capture.ts";
import { openCachePruning } from "./cache-pruning.ts";
import {
	type Config,
	type ConfigRef,
	ensureHomeLayout,
	goblinHome,
	loadConfig,
	missingAuthNames,
	paths,
	type TtsConfig,
} from "./config.ts";
import { type BootPins, sandboxConfigured, wireConfigWrite } from "./config-pins.ts";
import {
	type Conversation,
	captureConversationSettings,
	channelOf,
	openStore,
} from "./conversation.ts";
import {
	type DelegationLifecycle,
	delegationWake,
	startDelegationLifecycle,
	wireDelegation,
} from "./delegation-lifecycle.ts";
import { makeDesktops, openDesktops } from "./desktops.ts";
import { makeAppMailLane, presentProgramApproval } from "./app-approvals.ts";
import { handleAppApi, resolveAppAuth } from "./http/app-channel.ts";
import { startHttp } from "./http/mod.ts";
import { makeOperatorSeams } from "./http/operator.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { wireMailAuthority } from "./mail.ts";
import { startMailApproval, unavailableMailLane, type MailApproval } from "./mail-approval.ts";
import { openOutbox } from "./mail-outbox.ts";
import { makeMailNoticeRouter, startMailWatcher } from "./mail-watcher.ts";
import { type MemoryWorker, startMemoryWorker, wireMemory } from "./memory/mod.ts";
import { OutageTracker } from "./memory/outage.ts";
import { openNotes } from "./notes.ts";
import { makePodman } from "./podman.ts";
import { openPrograms } from "./programs.ts";
import { startProgramApproval, type ProgramApproval } from "./program-approval.ts";
import { startProgramOps } from "./program-ops.ts";
import { openProjects } from "./projects.ts";
import { wireReviewer } from "./reviewer.ts";
import { Runtime, type RuntimeDeps } from "./runtime.ts";
import { makeSandboxes, openSandboxes, warnIfStranded } from "./sandboxes.ts";
import { fireMail, fireWebhook, type SchedulerDeps, startScheduler } from "./scheduler.ts";
import { SkillSources } from "./skill-provenance.ts";
import { launchPin, type SpinOffDeps } from "./spinoff.ts";
import { openSubagentRuns } from "./subagent-runs.ts";
import { openSubagentsGuarded, type Subagents } from "./subagents/mod.ts";
import { telegramAddressOf } from "./targets.ts";

import { withTimeout } from "./tg/deadline.ts";
import { filterGuestTools } from "./tg/guest.ts";
import {
	makeTelegramMailLane,
	sendMailNotice,
	startTelegramMailApproval,
} from "./tg/mail-approval.ts";
import { AUTH_TELEGRAM_TOKEN, applyMenuButton, startBot, type RunningBot } from "./tg/mod.ts";
import { postProgramApproval, startTelegramProgramApproval } from "./tg/program-approval.ts";
import {
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendSkillProposedNotice,
} from "./tg/notify.ts";
import { openPings } from "./tg/pings.ts";
import { sendInterruptedTurnNotices } from "./tg/turn-notice.ts";
import { makeWakeDeps } from "./tg/wake.ts";
import { openTurnJournal } from "./turn-journal.ts";
import { makeResumeOps, makeResumeSinks, type ResumeOps } from "./turn-resume.ts";
import { wakeConversation } from "./wake.ts";
import { openResponsibilities, type ResponsibilityStore } from "./responsibilities.ts";
import { makeResponsibilityObserver } from "./responsibility-observer.ts";
import { makeResponsibilityService } from "./responsibility-service.ts";
import { makeWakeDispatcher, type WakeDispatcher } from "./wake-dispatcher.ts";
import { type DevelopmentInput, openWakeStore } from "./wake-store.ts";

// The file sink attaches before anything that can fail — boot errors
// must land in goblin.log, not stderr against an empty log.
setLogFile(paths.logFile());
process.on("unhandledRejection", (reason: unknown) => {
	log.error("unhandled rejection", reason);
});
process.on("uncaughtException", (err: unknown) => {
	log.error("uncaught exception", err);
	process.exit(1);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Long enough for the sinks' final flushes and polling's offset
// confirm; short enough that a wedged Telegram API can't hold a deploy.
// The startup-failure cleanup budgets a wedged close with it too.
const SHUTDOWN_DRAIN_MS = 10_000;

async function boot() {
	ensureHomeLayout();
	// /api/*/status reports from this — uptime and the boot timestamp.
	const startedAt = new Date().toISOString();

	const config = loadConfig();
	if (!config) {
		log.error(`no config at ${paths.config()} — copy goblin.json5.example and fill it in`);
		process.exit(1);
	}
	setLogLevel(config.logLevel);

	// Shared ref: the mini app swaps this in place on save; everything
	// reads .current at point of use.
	const configRef: ConfigRef = { current: config, ttsDown: false };
	// The Telegram client reads apiRoot once, at process start (tg/mod.ts).
	// A later save writes the file but not the live client, so it is hinted.
	const apiRootBoot = config.telegram.apiRoot;
	const auth = loadAuth();
	// Auth resolves lazily at point of use — a configured feature naming an
	// absent record is invisible until a real call fails. Name it at boot:
	// existence check only, no values resolved (doctor's coverage probe is
	// the deep version of this line).
	for (const name of missingAuthNames(config, (n) => auth.has(n))) {
		log.warn(
			"config references a missing auth.jsonl record — the feature needing it fails at first use",
			{
				auth: name,
			},
		);
	}
	const store = openStore(paths.db());
	// Browser push is an app-owned device registry. Its VAPID pair is an
	// auth record generated on first enable, not operator config.
	const appPush = openAppPush(store.db, {
		auth,
		storeSecret: (name, value) => {
			appendAuthRecord(paths.auth(), name, value);
			auth.put(name, value);
		},
		store,
		subject: () => configRef.current.publicUrl ?? "mailto:goblin@localhost",
	});
	const cacheObservations = openCacheObservation(store.db);
	// The context-window view's rows — the final step's outbound prompt
	// per conversation, recorded by the runtime, served read-only.
	const windowCapture = openWindowCapture(store.db);
	// The crash journal shares the store's handle like the tg inbox.
	// Its open reclassifies rows left 'running' — a graceful shutdown
	// fences first, so 'running' at open means the process died mid-turn.
	const turnJournal = openTurnJournal(store.db);
	// Durable wakes share the store handle — the trigger append, its
	// history reference, and the delivery state commit together. The
	// dispatcher binds after the runtime exists (the ownership hooks
	// late-bind through this slot); it is what the responsibility
	// service's developments ride.
	const wakeStore = openWakeStore(store.db);
	let wakeDispatcher: WakeDispatcher | undefined;
	// Late-bound like the dispatcher — the responsibility service is
	// built once the store and observer exist (after makeTurnTools is
	// assembled). The getter below reads this slot per turn.
	let responsibilitySvc: {
		resps: ReturnType<typeof openResponsibilities>;
		service: ReturnType<typeof import("./responsibility-service.ts").makeResponsibilityService>;
		listFor: () => ReturnType<typeof operatorHerdr.list>;
	} | null = null;
	// Inert without a hand-edited cachePruning block.
	const cachePruning = openCachePruning({
		store,
		observation: cacheObservations,
		getConfig: () => configRef.current,
	});
	// One table: the reviewer and the turn stream record, the operator
	// doors read.
	const skillSources = new SkillSources(store.db);
	for (const conv of store.listAppConversations()) store.initializeAppSettings(conv.id, config);
	const programs = openPrograms(paths.db());
	programs.rePinDmTopics();
	// The outbox opens unconditionally — drafts stay readable and
	// cancellable without the mail block; only the clients gate on it.
	const outbox = openOutbox(paths.db());
	// One Podman adapter serves sandbox and desktop rows — both drivers
	// reconcile against the same store of truth.
	const podman = makePodman();
	// The routing table is additive and unconditional: sandboxes read
	// worker leases from it whether or not the subagents block exists.
	const subagentRuns = openSubagentRuns(paths.db());
	// The sandbox lifecycle owner exists whether or not the block is
	// configured — the tool gate is the per-turn config read, and the
	// store is an additive table. Config is read live: resource limits
	// and idleHours apply to the next sandbox call, not the boot set.
	const sandboxStore = openSandboxes(paths.db());
	const sandboxes = makeSandboxes({
		podman,
		store: sandboxStore,
		config: () => configRef.current.sandbox,
		// A live worker run pins its sandbox: the reaper skips it and
		// reset refuses while a lease stands.
		runLease: (conv) => subagentRuns.workerLease(conv),
		// Destructive sandbox lifecycle (recreate/restart) reaches the
		// worker on its next tool result — persisted until carried.
		onLifecycle: (conv, note) => subagentRuns.noteLifecycle(conv, note),
	});
	// A block absent at boot or removed by a write strands the tracked
	// containers — warn only: a boot sweep would kill experiments; the
	// operator decides.
	const warnStrandedSandboxes = () => warnIfStranded(sandboxStore);
	if (!sandboxConfigured(config)) warnStrandedSandboxes();
	// Split mail authority: gws polling serves the watcher, the send client
	// only approval taps — mail.ts owns the gate; both are live-read getters.
	const { poller: mailPoller, sender: mailSender } = wireMailAuthority({ configRef, auth });
	// Delegation is boot-fixed like memory — the session is systemd's, not
	// ours. The fixtures (store, herdr adapters, targets) and the per-turn
	// dep gate live in delegation-lifecycle.ts; late()/launchPinDeps bind
	// after this point, so both reach it as call-time getters.
	const delegationBoot = config.delegation;
	const {
		delegations,
		herdr,
		operatorHerdr,
		targets: delegationTargets,
		delegateDeps,
	} = wireDelegation({
		config: delegationBoot,
		configRef,
		dbPath: paths.db,
		lifecycle: () => late().delegationLifecycle(),
		pin: (conv, name) => launchPin(launchPinDeps, conv, name),
	});

	// ---------- the wire step ----------
	//
	// Two construction cycles force late binding: the runtime's tools
	// reach the delegation lifecycle, whose wakes need bot.api — which
	// needs the bot, whose intake needs the runtime; and the retention
	// worker's notices need bot.api while the memory surfaces quiesce
	// through it. completeBoot() below is the one fill point, before the
	// deferred telegram task can replay inbox rows or admit a turn — an
	// unwired read past it is a boot-order bug.

	interface LateBoot {
		delegationLifecycle(): DelegationLifecycle;
		retention: MemoryWorker["withWorkerPaused"];
	}
	const lateBoot: { current: LateBoot | null } = { current: null };
	const completeBoot = (
		lifecycle: DelegationLifecycle | null,
		worker: MemoryWorker | null,
	): void => {
		if (lateBoot.current !== null) throw new Error("completeBoot called twice — boot-order bug");
		lateBoot.current = {
			delegationLifecycle: () => {
				if (lifecycle === null) throw new Error("delegation lifecycle not wired");
				return lifecycle;
			},
			retention: <T>(fn: () => Promise<T>): Promise<T> => {
				if (worker === null) throw new Error("retention worker not wired");
				return worker.withWorkerPaused(fn);
			},
		};
	};
	const late = (): LateBoot => {
		if (lateBoot.current === null) throw new Error("late boot not completed — wiring bug");
		return lateBoot.current;
	};

	// Voice replies and transcription die at runtime without ffmpeg —
	// the probe, the wav-kind gate, and the ttsDown flag live in
	// transcribe.ts (checkBootMedia).
	await checkBootMedia(config, configRef);

	// Warm both catalogs: thinking options and the mini app see real
	// levels, and the settings model picker gets names and API hosts
	// instead of a pre-name cache.
	void ensureModelsDevCatalog();
	void ensureOpenRouterCatalog();

	// Long-term memory is a boot-time snapshot — queue rows bind to the
	// endpoint+bank hash, so mini-app edits apply on restart, never mid-run.
	// memory/mod.ts owns the client, recall telemetry and door surfaces;
	// the retention pause seam is late-bound past the bot.
	const memory = wireMemory({
		config: config.memory,
		auth,
		store,
		retention: () => late().retention,
	});
	const {
		client: memoryClient,
		config: memoryBootConfig,
		noteRecall,
		surfaces: memorySurfaces,
	} = memory;

	// The retention outbox rides along whether or not a memory client
	// exists: pending rows can survive a disable, and project→off must
	// still purge them like /memory off. Submission needs the client;
	// purging does not.
	const projects = openProjects(store, { memoryQueue: store.memoryQueue });

	// One store for the tool, the app routes, and the project prompt's index.
	const notes = openNotes(store, { projects });

	const transcribeFile = makeTranscriber({ configRef, auth });
	const visionDepsFor = makeVisionDepsFor({ configRef, auth, observation: cacheObservations });
	const speak = makeSpeaker({ configRef, auth });

	// The one tool factory — the runtime builds the live set per turn
	// through it, and the resume contract check (turn-resume.ts)
	// rebuilds the surface through the same closure so the drift
	// comparison reads the set the resumed attempt would actually get.
	// The mount policy (which slots exist per channel/config/boot pin)
	// lives in turn-tools.ts; boot binds the seams and the late-bound
	// getters (subagents/mail/desktop bind past Runtime construction).
	const telegramEnabled = config.telegram.enabled;
	// The one operator-DM lane — the program tool's hook rotation and the
	// proposal approval's grant-time hook delivery share it (a secret URL
	// never enters history). An enabled-but-unattached channel (init
	// pending or failed) throws at call time — never a silent skip.
	let tg: RunningBot | null = null;
	// Stop/drain ownership is separate from routability: a detached
	// channel still owns intake that shutdown must drain.
	let telegramRunning: RunningBot | null = null;
	// The init task reads this after each await — a getMe landing during
	// shutdown must not attach or start polling.
	let telegramSealed = false;
	// Resolved inside the Telegram init task only; the HTTP bot-token
	// getter fails closed until the channel attaches.
	let telegramToken: string | undefined;
	const sendPrivate = telegramEnabled
		? makePrivateSender(
				(id, text) => {
					if (tg === null) throw new Error("telegram channel is unavailable");
					return withTimeout(tg.bot.api.sendMessage(id, text), "sendMessage");
				},
				() => configRef.current.operators,
			)
		: undefined;
	// Late-bound like mailApproval: shared owners and their Telegram
	// adapters start on channel attach, so getters answer undefined to
	// anything earlier rather than a half-wired gate.
	let programApproval: ProgramApproval | undefined;
	let mailApproval: MailApproval | undefined;
	let telegramProgramApproval: ReturnType<typeof startTelegramProgramApproval> | undefined;
	let telegramMailApproval: ReturnType<typeof startTelegramMailApproval> | undefined;
	const makeTurnTools = makeTurnToolsFactory({
		configRef,
		auth,
		store,
		projects,
		notes,
		programs,
		// The one send composed outside tg/ — same deadline as every tg/
		// sender, or a wedged API stalls the program turn's tool call.
		...(sendPrivate === undefined ? {} : { sendPrivate }),
		memory:
			memoryClient && memoryBootConfig
				? { client: memoryClient, config: memoryBootConfig, noteRecall }
				: null,
		transcribe: transcribeFile,
		delegateDeps,
		operatorHerdr,
		mail: () => mailApproval,
		programApproval: () => programApproval,
		visionDepsFor,
		sandboxes,
		subagents: () => subagents,
		desktops: () => desktops,
		subagentsBoot: () => subagentsBoot,
		responsibility: () => responsibilitySvc,
		filterGuests: filterGuestTools,
	});

	const stepBuilder = makeStepBuilder({
		configRef,
		auth,
		store,
		projects,
		notes,
		observation: cacheObservations,
	});

	const runtime = new Runtime({
		store,
		turnJournal,
		runOwnership: {
			begin: (e) => wakeDispatcher?.hooks.begin(e),
			members: (runId, ids) => wakeDispatcher?.hooks.members(runId, ids),
			end: (runId, status, delivery) => wakeDispatcher?.hooks.end(runId, status, delivery),
			preRunFailure: (e) => wakeDispatcher?.hooks.preRunFailure?.(e),
		},
		captureConversation: (conv) => captureConversationSettings(store, conv, configRef.current),
		pruneBetweenTurns: (convId) => {
			cachePruning.pruneConversation(convId);
		},
		recordWindow: windowCapture.record,
		...stepBuilder,
		makeTools: makeTurnTools,
		...(memory.turnDeps ? { memory: memory.turnDeps } : {}),
	});

	// One titler for both channels — implicit topics and app first-turn naming.
	const titleFor = makeTitleFor({ configRef, auth, observation: cacheObservations });
	const launchPinDeps: SpinOffDeps = {
		store,
		titleFor,
		publicUrl: () => configRef.current.publicUrl || undefined,
		appDefaults: () => configRef.current,
	};

	// Turn-write attribution is independent of the reviewer — a manual
	// skill authored mid-thread is provenance even when reviews are off.
	runtime.setSkillWatch({
		skillsDir: paths.skills(),
		proposedDir: paths.skillsProposed(),
		record: (conversationId, skill) => skillSources.record(conversationId, skill, "turn"),
	});

	// The explicit-resume surface (turn-resume.ts) is built below — it
	// needs the bot for its operator notices — but both doors resolve the
	// seam lazily, so the binding must exist before the awaits that let
	// traffic in. `undefined` in that window answers "not wired".
	let resumeOps: ResumeOps | undefined;
	// The bot attaches in the init task kicked after HTTP and the
	// scheduler stand — everything below boots on tg === null and binds
	// to the live seams when getMe lands.
	if (!telegramEnabled) {
		log.info("telegram channel disabled — bot auth, polling, and mini-app auth skipped");
	}

	// The shared mail approval owner — queue, CAS, send lifecycle and
	// expiry are channel-neutral; each door only presents and stamps.
	// The telegram lane is replaceable: the init task swaps in the real
	// adapter on attach, and detach restores the unavailable lane.
	const mailLanes = {
		app: makeAppMailLane(store),
		telegram: unavailableMailLane(
			telegramEnabled ? "telegram channel unavailable" : "telegram channel is disabled",
		),
	};
	mailApproval = startMailApproval({
		outbox,
		sender: mailSender,
		reader: mailPoller,
		lanes: mailLanes,
	});

	// The shared program grant owner — the durable decision path is one
	// for both doors. Presentation routes by target: Telegram posts its
	// chunked buttons; app turns get a durable approval marker.
	programApproval = startProgramApproval({
		programs,
		publicUrl: () => configRef.current.publicUrl || undefined,
		present: async (proposal, signal) => {
			if (telegramAddressOf(proposal.target) !== null) {
				if (tg === null) throw new Error("telegram channel is unavailable");
				await postProgramApproval(tg.bot.api, programs, proposal, signal);
			} else {
				presentProgramApproval(store, proposal);
			}
		},
	});
	// The Telegram-side adapter binds on channel attach (see the init
	// task) — programApproval itself is the shared, channel-neutral owner.
	const programOps = startProgramOps({
		programs,
		publicUrl: () => configRef.current.publicUrl || undefined,
		requestApproval: (proposal, signal) => programApproval!.requestApproval(proposal, signal),
	});

	// The retention worker boots before the channel — outage and blocked
	// notices deliver through bot.api (one per episode / per document).
	const memoryWorker = memoryClient
		? startMemoryWorker(store.memoryQueue, memoryClient, {
				outage: {
					tracker: new OutageTracker(store.db),
					notify: (conversationId, sinceMs, queued) =>
						sendMemoryOutageNotice(tg?.bot.api ?? null, conversationId, sinceMs, queued),
				},
				blocked: {
					notify: (conversationId, error, attempts) =>
						sendMemoryBlockedNotice(tg?.bot.api ?? null, conversationId, error, attempts),
				},
			})
		: null;

	// Save notices read the live api at call time — absent while detached.
	const { gate: system1Gate, reviewer: skillReviewer } = wireReviewer({
		configRef,
		auth,
		store,
		observation: cacheObservations,
		paths,
		notify: (conversationId, skills) =>
			sendSkillProposedNotice(tg?.bot.api ?? null, conversationId, skills),
		recordSources: (conversationId, reviewId, skills) => {
			for (const skill of skills)
				skillSources.record(conversationId, skill, "reviewer", undefined, reviewId);
		},
	});
	if (system1Gate !== null) {
		// The loop watchdog rides the same System1Client: every 16
		// completed calls system1 scores the digest ring — warn once,
		// cut on the second stuck verdict.
		runtime.setLoopWatchdog({ decide: system1Gate.decide.bind(system1Gate) });
	}
	if (skillReviewer !== null) runtime.setReviewer(skillReviewer);

	// The shared wake path — program fires and delegation notices submit
	// through it; wake.ts owns the routing. Intake opens its own pings handle
	// inside createBot. One wakeDeps OBJECT identity for the process: the
	// telegram init task mutates it in place on attach/detach so the
	// scheduler, delegation lifecycle, subagent wake and resume sinks all
	// read the same delivery surface at call time.
	const pings = openPings(store.db);
	const wakeBase = {
		store,
		runtime,
		configRef,
		synthesize: (text: string, tts: TtsConfig) => synthesizeSpeech(text, tts, { auth }),
		followUpGate: () => system1Gate ?? undefined,
		pings,
		push: appPush,
	};
	const wakeDeps = makeWakeDeps({ ...wakeBase, api: null });
	// Object.assign alone can't drop absent fields — delete the
	// telegram-only seams before laying the (re)built set down, so detach
	// restores the app-only bell rather than a stale delivery.
	const rewireWake = (api: Parameters<typeof makeWakeDeps>[0]["api"]): void => {
		delete wakeDeps.delivery;
		delete wakeDeps.markRoll;
		Object.assign(wakeDeps, makeWakeDeps({ ...wakeBase, api }));
	};

	// The explicit-resume surface (turn-resume.ts): /resume /decide
	// /abandon on Telegram, the app runs/* routes on the app channel.
	// Sinks mirror the wake path — an app lane's resumed turn pings the
	// operators through the bell; a telegram lane's delivers into its
	// own topic and DMs each operator the terminal outcome, since a
	// resumed turn is headless and nobody is watching a stream.
	resumeOps = makeResumeOps({
		store,
		journal: turnJournal,
		runtime,
		captureConversation: (conv) => captureConversationSettings(store, conv, configRef.current),
		makeTools: makeTurnTools,
		...makeResumeSinks({
			wake: wakeDeps,
			operators: () => configRef.current.operators,
			...(telegramEnabled
				? {
						sendDm: (chat: number, text: string) => {
							const running = tg;
							if (running === null) throw new Error("telegram channel is unavailable");
							return withTimeout(
								running.bot.api.sendMessage(chat, text),
								"sendMessage (resumed turn notice)",
							);
						},
					}
				: {}),
		}),
	});
	// Durable wake delivery — the dispatcher owns record→commit→submit
	// and the journal-run ownership the runtime announces through the
	// hooks bound above. Built after wakeDeps (the sinks it uses) and
	// before replayInbox: recovered wakes enter their lanes ahead of
	// inbound traffic. The boot pump replays the last crash boundary.
	wakeDispatcher = makeWakeDispatcher({
		store,
		wakes: wakeStore,
		journal: turnJournal,
		runtime,
		sinkFor: (conv) =>
			channelOf(conv.id) === "app" || wakeDeps.delivery === undefined
				? wakeDeps.bell(conv)
				: wakeDeps.delivery(conv),
	});
	wakeDispatcher.pump();
	const stopWakeTicker = wakeDispatcher.startTicker();

	// Project-owned responsibilities — the store the handover service
	// writes, and the deterministic observer that turns attachment
	// snapshots into deduped durable developments. The observer's list
	// seam is the local operator session; (server, session) on each
	// attachment is the grouping key for when a second target exists.
	const responsibilities: ResponsibilityStore = openResponsibilities(store.db);
	const responsibilityService = makeResponsibilityService({
		db: store.db,
		resps: responsibilities,
		wakes: wakeStore,
		conversations: store,
		pump: () => wakeDispatcher!.pump(),
		programs,
		// The committed epoch fence cancels the live turn before the
		// correction wake is admitted — a stale model stream, queued
		// tool call, or parked preflight can no longer act.
		onCorrectionCommitted: (conversationId, epoch) => {
			const { settled } = runtime.cancelFenced(conversationId, epoch);
			settled.catch((err) =>
				log.error("correction cancel settle failed", err, {
					conversation: conversationId,
					epoch,
				}),
			);
		},
	});
	responsibilitySvc = {
		resps: responsibilities,
		service: responsibilityService,
		listFor: () => operatorHerdr.list(),
	};
	// Boot sweep: every open responsibility re-verifies its follow-up
	// Program — a restart (or a deleted program row) re-links here,
	// never leaves the check-in silently unarmed.
	for (const r of responsibilities.open()) {
		try {
			responsibilityService.ensureFollowup(r.responsibilityId);
		} catch (err) {
			log.error("responsibility follow-up relink failed", err, {
				responsibility: r.responsibilityId,
			});
		}
	}
	const responsibilityObserver = makeResponsibilityObserver({
		db: store.db,
		resps: responsibilities,
		wakes: wakeStore,
		pump: () => wakeDispatcher!.pump(),
		list: () => operatorHerdr.list(),
	});
	const OBSERVE_MS = 60_000;
	const observerTicker = setInterval(() => {
		responsibilityObserver
			.observe()
			.catch((err) => log.error("responsibility observe tick failed", err));
	}, OBSERVE_MS);
	observerTicker.unref();
	const stopObserverTicker = () => clearInterval(observerTicker);

	// The scheduler rides the SAME wakeDeps object — a spread here would
	// snapshot delivery/bell before the telegram attach ever lands.
	const firingDeps: SchedulerDeps = Object.assign(wakeDeps, {
		programs,
		// Responsibility-destination programs fire as durable
		// developments on the coordination conversation — the
		// dispatcher owns their wake from the record on.
		responsibilities,
		recordDevelopment: (input: DevelopmentInput) => wakeDispatcher!.record(input),
		// The System One gate doubles as the watcher-event scorer (fail-open) — unscored absent.
		...(system1Gate ? { checkMail: system1Gate as Pick<typeof system1Gate, "decide"> } : {}),
	});

	// The delegation lifecycle wakes through the shared wakeDeps — its
	// closures read delivery/bell live, so a telegram attach mid-run is
	// visible without a rewire. The wire step lands before any turn.
	const delegationLifecycle =
		delegations !== null && herdr !== null
			? startDelegationLifecycle({
					delegations,
					herdr,
					targets: delegationTargets,
					delegationsDir: paths.delegations(),
					homeDir: homedir(),
					...delegationWake(wakeDeps),
				})
			: null;
	completeBoot(delegationLifecycle, memoryWorker);

	// The subagent owner is boot-frozen like delegation: its config
	// (models, pool limits, auth refs) is one snapshot. Construction —
	// including crash recovery over Pi Durable's storage — runs only
	// after the late-boot bindings land: a settle during open may wake
	// through wakeDeps immediately. Desktops construct empty-handed:
	// no allocation or reaping happens at boot, rows reconcile on use.
	const subagentsBoot = config.subagents;
	const desktops =
		subagentsBoot !== undefined
			? makeDesktops({
					podman,
					store: openDesktops(paths.db()),
					// Boot-frozen like the owner's block — a live read would
					// make the restart warning a lie.
					config: () => subagentsBoot?.desktops,
				})
			: null;
	// The owner open is fail-open — a poisoned auth record or a resume
	// refusal disables the feature rather than crash-looping the
	// service (openSubagentsGuarded owns that policy; the close join
	// rides the same budget as the shutdown drain).
	let subagents: Subagents | null = null;
	if (subagentsBoot !== undefined && desktops !== null) {
		subagents = await openSubagentsGuarded(
			{
				config: subagentsBoot,
				runs: subagentRuns,
				auth,
				sandboxes,
				desktops,
				storagePath: join(paths.state(), "subagents.sqlite"),
				transferRoot: join(paths.state(), "subagent-transfer"),
				wake: (conv, text) => wakeConversation(wakeDeps, conv, text),
			},
			SHUTDOWN_DRAIN_MS,
		);
	}

	// App auth mode resolves once at boot: appToken set → bearer, unset →
	// trust (the tailnet is the lock); a mid-run flip needs a restart.
	const appTokenName = resolveAppAuth(config.appToken);
	// Boot-pinned blocks: memory binds queue rows to the endpoint+bank hash,
	// delegation/subagents freeze adapters and pool limits at boot — a
	// mid-run change is a warn + restart.
	const bootPins: BootPins = {
		memory: memoryBootConfig,
		appToken: appTokenName,
		telegramEnabled,
		apiRoot: apiRootBoot,
		delegation: delegationBoot,
		subagents: subagentsBoot,
	};
	// One post-write path for every config door: hot-apply what's live,
	// flip-log what joins/leaves the tool set, warn on what's boot-pinned —
	// config-pins.ts owns the reconcile.
	const { onConfigWritten, restartHints } = wireConfigWrite({
		configRef,
		boot: config,
		pins: bootPins,
		// publicUrl is operator-editable — keep the menu button in sync
		// without a restart.
		syncMenuButton: () => {
			if (tg !== null) applyMenuButton(tg.bot.api, configRef.current.publicUrl);
		},
		warnStrandedSandboxes,
	});
	// The operator surface (settings, memory, programs, delegations,
	// status) is one bundle mounted at both doors — the mini app's
	// /api/* (initData) and the app channel's /api/app/* (bearer/trust).
	// http/operator.ts owns the assembly; boot binds configRef and
	// onConfigWritten per door.
	const operatorSeams = makeOperatorSeams({
		store,
		memory,
		programs,
		delegations,
		skillSources,
		auth,
		paths,
		version: pkg.version,
		startedAt,
		restartHints,
	});
	const http = startHttp({
		configRef,
		...operatorSeams,
		// Late-bound and fail-closed: until the telegram attach lands,
		// mini-app initData has no token to validate against and refuses.
		get botToken() {
			return tg === null ? undefined : telegramToken;
		},
		// POST /hook/<token> — the token is the credential; the webhook
		// entry point owns the fire's accounting (last_run only when landed).
		hooks: {
			programs,
			accepting: () => runtime.accepting(),
			fire: (program, event, now) => fireWebhook(firingDeps, program, event, now),
		},
		// The System One gate doubles as the loopback injection checker — absent = 503.
		...(system1Gate ? { checkInjection: { gate: system1Gate } } : {}),
		// The app handler stays opaque here: app-channel.ts imports the
		// runtime/AI-SDK graph, which must not enter http/mod.ts's DOM-lib
		// typecheck program.
		appApi: (req, url) =>
			handleAppApi(req, url, appTokenName, {
				store,
				runtime,
				projects,
				notes,
				auth,
				configRef,
				onConfigWritten,
				// Same seams the mini-app door reads — app-channel mounts
				// them under /api/app/* with the bearer/trust gate.
				operator: operatorSeams,
				resumeOps: () => resumeOps,
				// Both doors reach the same durable CAS owners; this route
				// supplies the authenticated app actor, never transport authority.
				...(programApproval !== undefined && mailApproval !== undefined
					? { approvals: { program: programApproval, mail: mailApproval } }
					: {}),
				programOps,
				push: appPush,
				// The project feed + controls — the same stores the
				// coordination tool drives; record pumps through the
				// dispatcher so a correction steers the next wake.
				responsibilities: {
					feed: { db: store.db, resps: responsibilities, programs },
					resps: responsibilities,
					service: responsibilityService,
					listAgents: () => operatorHerdr.list(),
				},
				// Same intake seam as the tg lane — speech uploads transcribe before submit.
				transcribe: transcribeFile,
				// Null = unconfigured or ffmpeg-down — the endpoint answers 503
				// rather than failing mid-synthesis (tts.ts owns the gate).
				speak,
				windowCapture,
				titleFor,
				// Selection rewrite — the configured root model/thinking;
				// generation only, the accepted proposal returns via PATCH.
				rewriteNote: (noteId, input, signal) =>
					generateNoteRewrite(
						{ configRef, auth, observation: cacheObservations },
						{ noteId, selection: input.selection, instruction: input.instruction, signal },
					),
			}),
		onConfigWritten,
	});

	// The scheduler submits through bot.api; the boot scan fires anything
	// missed while down.
	const scheduler = startScheduler(firingDeps);

	// The mail watcher is the scheduler's twin over gws, handing matches to the
	// mail entry point (which owns checkpoints); always started — it idles
	// without the block.
	const mailWatcher = startMailWatcher({
		programs,
		reader: mailPoller,
		fire: (program, hits, checkpoint, now) => fireMail(firingDeps, program, hits, checkpoint, now),
		notify: makeMailNoticeRouter({
			resps: responsibilities,
			record: (input) => wakeDispatcher.record(input),
			sendTelegram: (address, text) => {
				if (tg === null) {
					log.warn(
						telegramEnabled
							? "mail outage notice skipped — telegram channel unavailable"
							: "mail outage notice skipped — telegram channel disabled",
						{ chat: address.chatId, thread: address.threadId },
					);
					return Promise.resolve();
				}
				return sendMailNotice(tg.bot.api, address, text);
			},
		}),
	});

	// ---------- deferred telegram attach ----------
	//
	// One bounded attempt (getMe carries the shared 30s deadline), kicked
	// only after every core service stands — the app channel, HTTP, the
	// scheduler and the mail watcher must never wait on bot auth. A
	// failed attempt leaves every telegram seam unavailable and asks for
	// a config repair plus approved restart; there is no retry loop.
	const attachTelegram = (running: RunningBot): void => {
		mailLanes.telegram = makeTelegramMailLane(running.bot.api);
		if (mailApproval !== undefined) {
			telegramMailApproval = startTelegramMailApproval({
				api: running.bot.api,
				approval: mailApproval,
			});
		}
		if (programApproval !== undefined && sendPrivate !== undefined) {
			telegramProgramApproval = startTelegramProgramApproval({
				api: running.bot.api,
				approval: programApproval,
				programs,
				sendPrivate,
			});
		}
		rewireWake(running.bot.api);
		tg = running;
		log.info("telegram channel attached", { bot: running.bot.botInfo.username });
	};
	const detachTelegram = (): void => {
		tg = null;
		telegramMailApproval = undefined;
		telegramProgramApproval = undefined;
		mailLanes.telegram = unavailableMailLane("telegram channel unavailable");
		rewireWake(null);
		// telegramRunning stays — its intake still belongs to this boot and
		// shutdown drains it even while routing reads detached.
	};
	const telegramInit = telegramEnabled
		? (async () => {
				try {
					// The token resolves inside this task only — the HTTP door
					// fails closed until the attach below sets it live.
					telegramToken = await auth.resolve(AUTH_TELEGRAM_TOKEN);
					if (telegramSealed || !runtime.accepting()) {
						log.info("telegram attach skipped — shutdown in progress");
						return;
					}
					const running = await startBot({
						configRef,
						auth,
						store,
						runtime,
						titleFor,
						async synthesize(text, tts) {
							return synthesizeSpeech(text, tts, { auth });
						},
						transcribe: transcribeFile,
						...(memorySurfaces ? { memory: { ...memorySurfaces } } : {}),
						mail: () => telegramMailApproval,
						programApproval: () => telegramProgramApproval,
						followUpGate: () => system1Gate ?? undefined,
						resumeOps: () => resumeOps,
					});
					// Own the bot the moment it exists — a later detach or a
					// seal mid-replay must never strand its stop/drain.
					telegramRunning = running;
					if (telegramSealed || !runtime.accepting()) {
						log.info("telegram attach skipped — shutdown in progress");
						return;
					}
					attachTelegram(running);
					// Rows reclassified 'interrupted' at open get one DM per
					// operator — terse facts, never a replay. Sent only after a
					// successful attach; the skip/failure logs above stand alone.
					sendInterruptedTurnNotices(
						running.bot.api,
						turnJournal.interruptedAtOpen,
						configRef.current.operators,
						(id) => store.get(id)?.title ?? undefined,
					);
					if (telegramSealed || !runtime.accepting()) {
						detachTelegram();
						return;
					}
					// Replay before polling — the offset must not advance past
					// journaled input — then poll with a detach-on-end contract:
					// a terminated long poll degrades the channel, never the boot.
					await running.replayInbox();
					if (telegramSealed || !runtime.accepting()) {
						detachTelegram();
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
					scheduler.tick();
				} catch (err) {
					log.error(
						"telegram channel init failed — running without it; fix the credentials/config and restart",
						err,
					);
					detachTelegram();
				}
			})().catch((err: unknown) => {
				log.error("telegram init task failed", err);
				detachTelegram();
			})
		: Promise.resolve();

	// Shutdown's telegram stop: seals the attach path first (a late getMe
	// can no longer bind), detaches routing, stops polling only if it is
	// actually running, drains intake, and joins the init task — all under
	// the caller's shared drain budget, never its own timer.
	const stopTelegram = (): Promise<unknown> => {
		telegramSealed = true;
		// Owner, not router: a detached channel still has intake to drain.
		const running = telegramRunning;
		if (tg !== null) detachTelegram();
		const pollStop =
			running !== null && running.bot.isRunning() ? running.bot.stop() : Promise.resolve();
		const intake = running === null ? Promise.resolve() : running.drainIntake();
		const joined = Promise.allSettled([pollStop, intake, telegramInit]);
		return joined.then((results) => {
			const labels = ["telegram poll stop", "telegram intake drain", "telegram init join"];
			for (const [i, r] of results.entries()) {
				if (r.status === "rejected") {
					log.warn("shutdown step failed", r.reason, { step: labels[i] });
				}
			}
		});
	};

	return {
		configRef,
		auth,
		store,
		programs,
		outbox,
		delegations,
		runtime,
		wakeDispatcher,
		stopWakeTicker,
		responsibilities,
		responsibilityObserver,
		stopObserverTicker,
		stopTelegram,
		http,
		scheduler,
		delegationLifecycle,
		mailWatcher,
		mailApproval,
		programApproval,
		// Live closure over the attach/detach-rebound Telegram adapter —
		// shutdown joins in-flight taps through it without racing a
		// detach that happened after boot returned.
		stopTelegramProgramApproval: () => telegramProgramApproval?.stop() ?? Promise.resolve(),
		memoryWorker,
		subagentRuns,
		subagents,
		desktops,
	};
}

let booted: Awaited<ReturnType<typeof boot>>;
try {
	booted = await boot();
} catch (err) {
	log.error("boot failed", err);
	process.exit(1);
}
const {
	store,
	programs,
	outbox,
	delegations,
	runtime,
	wakeDispatcher,
	stopWakeTicker,
	stopObserverTicker,
	stopTelegram,
	http,
	scheduler,
	delegationLifecycle,
	mailWatcher,
	mailApproval,
	programApproval,
	stopTelegramProgramApproval,
	memoryWorker,
	subagentRuns,
	subagents,
} = booted;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) {
		log.warn("second signal — forcing exit", { signal });
		process.exit(1);
	}
	shuttingDown = true;
	log.info("shutting down", { signal });
	// Scheduler first — no new program submits once the drain begins.
	scheduler.stop();
	// Wake retries stop too — open wakes ride to the next boot's pump.
	stopWakeTicker();
	stopObserverTicker();
	// Join any in-flight scan before closing the store; running agents
	// belong to herdr and resume on next boot.
	const delegationScan = delegationLifecycle?.stopTicker() ?? Promise.resolve();
	// The mail watcher stops polling and joins an in-flight scan — a late
	// fire must not land in a closed runtime; cursors and drafts persist.
	const mailScan = mailWatcher.stop();
	// The approval gate stops sweeping AND joins an in-flight Gmail send
	// bounded by the drain budget below.
	const mailSends = mailApproval.stop();
	// Program approvals join in-flight posts and taps the same way — an
	// approved hook commits activation before its private credential
	// delivery, and the token's plaintext exists only inside that handler.
	// The Telegram adapter's stop reads live, before stopTelegram detaches.
	const telegramProgramJoins = stopTelegramProgramApproval();
	const programJoins = programApproval?.stop() ?? Promise.resolve();
	// The retention worker aborts its in-flight request and yields — the
	// outbox rows stay durable for the next boot. Joined under the budget
	// like everything else: a wedged memory service is not a deploy hold.
	const retention = memoryWorker?.stop() ?? Promise.resolve();
	// bot.stop confirms the polling offset so handled updates don't
	// redeliver on the next boot. stopTelegram seals the attach path,
	// stops polling only if it is running, drains intake, and joins the
	// deferred init task — the channel may not even have attached yet.
	const stopping = stopTelegram();
	// Close the runtime first — intake that lands during the drain still
	// reaches history but never starts a turn.
	const drained = runtime.shutdown();
	// Pause only: pending subagent runs persist for the next boot — the
	// harness close seals admission, it never aborts work.
	const subagentsClosed = subagents
		? subagents.close().catch((err: unknown) => {
				log.warn("subagents close failed", err);
			})
		: Promise.resolve();
	const settled = Promise.allSettled([
		stopping,
		drained,
		delegationScan,
		mailScan,
		mailSends,
		programJoins,
		telegramProgramJoins,
		retention,
		subagentsClosed,
	]);
	const finished = await Promise.race([
		settled.then(() => true),
		sleep(SHUTDOWN_DRAIN_MS).then(() => false),
	]);
	if (!finished) {
		log.warn("shutdown drain exceeded budget — exiting anyway", {
			budgetMs: SHUTDOWN_DRAIN_MS,
		});
	} else {
		for (const r of await settled) {
			if (r.status === "rejected") {
				log.warn("shutdown step failed", r.reason);
			}
		}
	}
	http.stop();
	// Runs outlive the process: the table closes only when the owner
	// joined inside the drain budget — a timed-out close leaves the
	// store open rather than let a lingering settle write a closed
	// handle (the process exits anyway).
	if (finished) {
		subagentRuns.close();
	}
	store.close();
	programs.close();
	outbox.close();
	delegations?.close();
	log.info("bye", { signal });
	process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		void shutdown(sig).catch((err) => {
			log.error("shutdown failed", err);
			process.exit(1);
		});
	});
}

log.startup("goblin up", { home: goblinHome(), port: http.port });
