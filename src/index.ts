import { homedir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";
import { createClaudeEngine } from "./agent/claude-code/mod.ts";
import { openClaudeSessions } from "./claude-sessions.ts";
import { createChatGptLogin, ensureCodexProvider } from "./agent/codex/login.ts";
import { ensureCodexModels } from "./agent/codex/models.ts";
import { ensureModelsDevCatalog, ensureOpenRouterCatalog } from "./agent/models-dev.ts";
import { generateNoteRewrite } from "./agent/note-rewrite.ts";
import { makeStepBuilder } from "./agent/step.ts";
import { makeTitleFor } from "./agent/title.ts";
import { checkBootMedia, makeTranscriber } from "./agent/transcribe.ts";
import { makeSpeaker } from "./agent/tts.ts";
import { makeTurnTools as makeTurnToolsFactory } from "./agent/turn-tools.ts";
import { makeVisionDepsFor } from "./agent/vision.ts";
import { makeAppMailLane, presentProgramApproval } from "./app-approvals.ts";
import { openAppPush } from "./app-push.ts";
import { appendAuthRecord, loadAuth } from "./auth.ts";
import { wireDelivery } from "./boot/delivery.ts";
import { openTelegramAttach } from "./boot/telegram-attach.ts";
import { newestTurnCall, openCacheObservation } from "./cache-observation.ts";
import { createIdleCompactor } from "./idle-compaction.ts";
import { openCachePruning } from "./cache-pruning.ts";
import { sweepScreenshotFrames } from "./frame-stubs.ts";
import {
	type ConfigRef,
	loadConfig,
	missingAuthNames,
	warnOnExampleOperator,
} from "./config.ts";
import type { Config } from "./config-schema.ts";
import { goblinHome } from "./goblin-home.ts";
import { ensureDir, ensureHomeLayout, paths } from "./home-layout.ts";
import { acquireHomeLock } from "./home-lock.ts";
import { type BootPins, sandboxConfigured, wireConfigWrite } from "./config-pins.ts";
import { captureConversationSettings, openStore } from "./conversation.ts";
import { delegationWake, makeDelegateDeps, wireDelegation } from "./delegation-lifecycle.ts";
import { makeT3 } from "./t3.ts";
import { makeGitHub } from "./github.ts";
import { makeWatches } from "./watches.ts";
import { makePosts } from "./posts.ts";
import { makeAsks } from "./asks.ts";
import { makeWatchObserver } from "./watch-observer.ts";
import { startDelegationLifecycle } from "./delegation-watcher.ts";
import { makeDesktops } from "./desktops.ts";
import { openDesktops } from "./desktops-store.ts";
import { type AppChannelDeps, handleAppApi, resolveAppAuth } from "./http/app-channel.ts";
import { openAppLive } from "./http/app-live.ts";
import { startHttp } from "./http/mod.ts";
import { makeOperatorSeams } from "./http/operator.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { wireMailAuthority } from "./mail.ts";
import { startMailApproval, unavailableMailLane } from "./mail-approval.ts";
import { openOutbox } from "./mail-outbox.ts";
import { makeMailNoticeRouter, startMailWatcher } from "./mail-watcher.ts";
import { wireMemory } from "./memory/mod.ts";
import { openNotes } from "./notes.ts";
import { makePodman } from "./podman.ts";
import { startProgramApproval } from "./program-approval.ts";
import { startProgramOps } from "./program-ops.ts";
import { openPrograms } from "./programs.ts";
import { startAgentChildren } from "./agent-children.ts";
import { openProjects } from "./projects.ts";
import { wireReviewer } from "./reviewer-wiring.ts";
import { Runtime } from "./runtime.ts";
import { makeSandboxes, openSandboxes, warnIfStranded } from "./sandboxes.ts";
import { fireMail, fireWebhook, startScheduler } from "./scheduler.ts";
import { SkillSources } from "./skill-provenance.ts";
import { curatorConfig, passDue, runCuratorPass } from "./skill-curator.ts";
import {
	noteSkillPatch,
	noteSkillUse,
	readSkillUsage,
	writeSkillUsage,
} from "./skill-usage.ts";
import { skillUnderPath } from "./turn/skill-attribution.ts";
import { launchPin, type SpinOffDeps } from "./spinoff.ts";
import { telegramAddressOf } from "./targets.ts";
import { filterGuestTools } from "./tg/guest.ts";
import { sendMailNotice } from "./tg/mail-approval.ts";
import { applyMenuButton } from "./tg/mod.ts";
import {
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendSkillProposedNotice,
} from "./tg/notify.ts";
import { postProgramApproval } from "./tg/program-approval.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import { appendInterruptedProgress } from "./turn/unlanded-progress.ts";
import { openTurnJournal } from "./turn-journal.ts";
import { openWakeStore } from "./wake-store.ts";
import { openWindowCapture } from "./window-capture.ts";
import { every, sleep } from "./timing.ts";

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

// Long enough for the sinks' final flushes and polling's offset
// confirm; short enough that a wedged Telegram API can't hold a deploy.
// The startup-failure cleanup budgets a wedged close with it too.
const SHUTDOWN_DRAIN_MS = 10_000;
let idleCompactor: ReturnType<typeof createIdleCompactor> | null = null;

// Take ownership before layout seeding, databases, or any service starts.
// Only this real process entry owns the home lock; boot helpers and tools do not.
ensureDir(paths.state());
const home = goblinHome();
let homeLock: ReturnType<typeof acquireHomeLock>;
try {
	homeLock = acquireHomeLock(home);
} catch (err) {
	log.error("home lock refused", err, { home });
	process.exit(1);
}
log.info("home lock acquired", { pid: process.pid, home });

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
	warnOnExampleOperator(config);
	const delegationBoot = config.delegation;
	// Shared ref: the mini app swaps this in place on save; everything
	// reads .current at point of use.
	const configRef: ConfigRef = { current: config, ttsDown: false };
	// The Telegram client reads apiRoot once, at process start (tg/bot.ts).
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
	const wallClock = (): Date => new Date();
	const store = openStore(paths.db());
	const watches = makeWatches(store.db, wallClock);
	const posts = makePosts(store.db, wallClock);
	const asks = makeAsks(store.db, wallClock);
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
	// leaves its fenced rows 'running' on purpose (#471), so 'running'
	// at open means the turn died with the process — and records each
	// such run's unlanded progress in history inside the same
	// transaction (#195): the work that already happened stays
	// transcript even though the process never got to say so.
	const turnJournal = openTurnJournal(store.db, {
		onInterrupted: (run, calls) => appendInterruptedProgress(store, run, calls),
		modelCallId: (conversationId) => newestTurnCall(store.db, conversationId),
	});
	const wakeStore = openWakeStore(store.db);
	// Inert without a hand-edited cachePruning block.
	const cachePruning = openCachePruning({
		store,
		observation: cacheObservations,
		getConfig: () => configRef.current,
	});
	// One table: the reviewer and the turn stream record, the operator
	// doors read.
	const skillSources = new SkillSources(store.db);
	// The deterministic curator pass — boot and turn completion, gated
	// on the sidecar's lastCuratorRun (design/skills.md → Self-authoring,
	// /learn, curator). Config reads live: no restart-pinning. The
	// sidecar write is one-process (this boot); a pass throw logs.
	const curatorPass = (): void => {
		const cfg = curatorConfig(configRef.current.curator);
		if (cfg === undefined) return; // absent block = off
		const now = new Date();
		const usagePath = paths.skillUsage();
		const file = readSkillUsage(usagePath);
		if (!passDue(file, now)) return;
		const { file: next, counters } = runCuratorPass(file, skillSources.managedNames(), cfg, now);
		writeSkillUsage(usagePath, next);
		log.info("curator pass", {
			...counters,
			staleDays: cfg.staleDays,
			archiveDays: cfg.archiveDays,
		});
	};
	try {
		curatorPass();
	} catch (err) {
		// Boot must survive a dirty sidecar or a busy filesystem — the
		// next turn completion retries.
		log.warn("boot curator pass failed — retried after the next settled turn", err, {});
	}
	for (const id of store.listAppConversationIds()) store.initializeAppSettings(id, config);
	const programs = openPrograms(paths.db());
	programs.rePinDmTopics();
	// The outbox opens unconditionally — drafts stay readable and
	// cancellable without the mail block; only the clients gate on it.
	const outbox = openOutbox(paths.db());
	// One Podman adapter serves sandbox and desktop rows — both drivers
	// reconcile against the same store of truth.
	const podman = makePodman();
	// The sandbox lifecycle owner exists whether or not the block is
	// configured — the tool gate is the per-turn config read, and the
	// store is an additive table. Config is read live: resource limits
	// and idleHours apply to the next sandbox call, not the boot set.
	const sandboxStore = openSandboxes(paths.db());
	const sandboxes = makeSandboxes({
		podman,
		store: sandboxStore,
		config: () => configRef.current.sandbox,
	});
	// A block absent at boot or removed by a write strands the tracked
	// containers — warn only: a boot sweep would kill experiments; the
	// operator decides.
	const warnStrandedSandboxes = () => warnIfStranded(sandboxStore);
	if (!sandboxConfigured(config)) warnStrandedSandboxes();
	// Split mail authority: gws polling serves the watcher, the send client
	// only approval taps — mail.ts owns the gate; both are live-read getters.
	const { poller: mailPoller, sender: mailSender } = wireMailAuthority({ configRef, auth });
	const telegramEnabled = config.telegram.enabled;
	// The Telegram attach state machine — src/boot/telegram-attach.ts owns
	// the channel's slots, the operator-DM lane (sendPrivate), and the
	// fail-closed seams everything below binds to (api, botToken); its
	// init task starts only after every core service stands.
	const attach = openTelegramAttach({ telegramEnabled, configRef });
	const sendPrivate = attach.sendPrivate;
	const { delegations, hc } = wireDelegation({
		config: delegationBoot,
		dbPath: paths.db,
	});
	const t3 = makeT3();
	const github = makeGitHub();
	// Voice replies and transcription die at runtime without ffmpeg —
	// the probe, the wav-profile gate, and the ttsDown flag live in
	// transcribe.ts (checkBootMedia).
	await checkBootMedia(config, configRef, auth);

	// Warm both catalogs: thinking options and the mini app see real
	// levels, and the settings model picker gets names and API hosts
	// instead of a pre-name cache.
	void ensureModelsDevCatalog();
	void ensureOpenRouterCatalog();
	// Codex providers read their own account-scoped list — warmed like
	// the shared catalogs so the first settings view isn't typed-ref only.
	for (const p of Object.values(config.providers)) {
		if (p.kind === "codex") void ensureCodexModels(p.authFile);
	}

	// Long-term memory is a boot-time snapshot — queue rows bind to the
	// endpoint+bank hash, so mini-app edits apply on restart, never mid-run.
	// memory/mod.ts owns the client, worker, outage tracker, recall telemetry
	// and door surfaces. The worker starts before the channel attaches;
	// outage and blocked notices use the live bot.api, and the tracker feeds
	// the app Attention projection.
	const memory = wireMemory({
		config: config.memory,
		auth,
		store,
		notices: {
			outage: (c, s, q) => sendMemoryOutageNotice(attach.api(), c, s, q),
			blocked: (c, e, a) => sendMemoryBlockedNotice(attach.api(), c, e, a),
		},
	});
	const {
		client: memoryClient,
		config: memoryBootConfig,
		noteRecall,
		surfaces: memorySurfaces,
		worker: memoryWorker,
		outageTracker,
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

	// The claude-code engine: bound whenever a claude-code provider is
	// configured; harmless (never spawned) otherwise. Auth resolution and
	// child env assembly happen per turn inside the engine. The session
	// store (#418) is shared with the runtime — the engine's native
	// compaction reads/writes the same records the turn path does.
	const claudeSessions = openClaudeSessions(store.db);
	const claudeEngine = createClaudeEngine({
		auth,
		configRef,
		observation: cacheObservations,
		sessions: claudeSessions,
	});

	const stepBuilder = makeStepBuilder({
		configRef,
		auth,
		store,
		projects,
		notes,
		observation: cacheObservations,
		claudeEngine,
	});

	const runtime = new Runtime({
		store,
		turnJournal,
		// First match wins: the claude engine accepts ClaudeSteps, the
		// ai-sdk engine everything else (turn/engine.ts pickEngine).
		engines: [claudeEngine, aiSdkEngine],
		captureConversation: (conv) => captureConversationSettings(store, conv, configRef.current),
		modelFallbacks: () => configRef.current.modelFallbacks,
		pruneBetweenTurns: (convId) => {
			cachePruning.pruneConversation(convId);
			// Unconditional media hygiene (issue #606) — old screenshot
			// frames stub to text regardless of cache-pruning config.
			sweepScreenshotFrames(store, convId);
		},
		recordWindow: windowCapture.record,
		windowVersion: windowCapture.version,
		claudeSessions,
		// The curator pass gate: boot and every settled turn, off the
		// reply path. Its own interval check makes it a no-op until due.
		onTurnSettled: (id) => {
			try {
				curatorPass();
			} catch (err) {
				log.warn("curator pass failed — retried after the next settled turn", err, {});
			}
			idleCompactor?.arm(id);
		},
		...stepBuilder,
		...(memory.turnDeps ? { memory: memory.turnDeps } : {}),
	});
	idleCompactor = createIdleCompactor({
		call: (id) => cacheObservations.idleCacheCall(id),
		lastFoldMs: (id) => {
			const createdAt = store.getCompaction(id)?.createdAt;
			if (createdAt === undefined) return null;
			const ms = Date.parse(createdAt);
			if (Number.isNaN(ms)) throw new Error(`compaction createdAt is not a date: ${createdAt} (${id})`);
			return ms;
		},
		recentConversations: (sinceMs) => cacheObservations.recentConversations(sinceMs),
		fold: (id) => runtime.idleFold(id),
		now: Date.now,
	});
	idleCompactor.armAll();

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
	// The same seam bumps the usage sidecar's patch counter (a draft
	// write counts too — the name's engagement is real either way).
	runtime.setSkillWatch({
		skillsDir: paths.skills(),
		proposedDir: paths.skillsProposed(),
		record: (conversationId, skill) => {
			skillSources.record(conversationId, skill, "turn");
			noteSkillPatch(paths.skillUsage(), skill, new Date());
		},
	});

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
	const mailApproval = startMailApproval({
		outbox,
		sender: mailSender,
		reader: mailPoller,
		lanes: mailLanes,
	});

	// The shared program grant owner — the durable decision path is one
	// for both doors. Presentation routes by target: Telegram posts its
	// chunked buttons; app turns get a durable approval marker.
	const programApproval = startProgramApproval({
		programs,
		publicUrl: () => configRef.current.publicUrl || undefined,
		present: async (proposal, signal) => {
			if (telegramAddressOf(proposal.target) !== null) {
				const api = attach.api();
				if (api === null) throw new Error("telegram channel is unavailable");
				await postProgramApproval(api, programs, proposal, signal);
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
		requestApproval: (proposal, signal) => programApproval.requestApproval(proposal, signal),
	});

	// Save notices read the live api at call time — absent while detached.
	const { gate: system1Gate, reviewer: skillReviewer } = wireReviewer({
		configRef,
		auth,
		store,
		observation: cacheObservations,
		paths,
		notify: (conversationId, skills) =>
			sendSkillProposedNotice(attach.api(), conversationId, skills, paths.skillsProposed()),
		recordSources: (conversationId, reviewId, skills) => {
			// The patch bump rides the provenance record — a reviewer draft
			// write is real engagement with the name (design/skills.md →
			// Self-authoring, /learn, curator).
			for (const skill of skills) {
				skillSources.record(conversationId, skill, "reviewer", undefined, reviewId);
				noteSkillPatch(paths.skillUsage(), skill, new Date());
			}
		},
	});
	if (system1Gate !== null) {
		// The loop watchdog rides the same System1Client: every 16
		// completed calls system1 scores the digest ring — warn once,
		// cut on the second stuck verdict.
		runtime.setLoopWatchdog({ decide: system1Gate.decide.bind(system1Gate) });
	}
	if (skillReviewer !== null) runtime.setReviewer(skillReviewer);

	const delivery = wireDelivery({
		store,
		runtime,
		journal: turnJournal,
		wakes: wakeStore,
		configRef,
		auth,
		push: appPush,
		gate: system1Gate,
		programs,
	});

	// The desktop pool constructs empty-handed: no allocation or
	// reaping happens at boot, rows reconcile on use. It exists before
	// the agent-children engine — a computer child's settlement
	// releases its leases through it, boot recovery included. Boot-frozen
	// like delegation: pool limits are one snapshot.
	const desktopsBoot = config.desktops;
	const desktops =
		desktopsBoot !== undefined
			? makeDesktops({
					podman,
					store: openDesktops(paths.db()),
					config: () => desktopsBoot,
				})
			: null;

	// Native subagents (design/agents.md → agent): the child engine
	// rides the shared runtime and settles through the dispatcher's
	// record seam — both exist only here, past the wire. Boot recovery
	// runs before any new traffic: a child cut by the restart settles
	// failed and its parent's wake is durable.
	const agentChildren = startAgentChildren({
		store,
		runtime,
		record: (input) => delivery.dispatcher.record(input),
		bell: (conv) => delivery.wakeDeps.bell(conv),
		maxRunning: () => configRef.current.agents?.maxRunning ?? 3,
		now: wallClock,
		desktops: () => desktops,
	});

	// The delegation lifecycle wakes through the shared wakeDeps — its
	// closures read delivery/bell live, so a telegram attach mid-run is
	// visible without a rewire.
	const delegationLifecycle =
		delegations !== null && hc !== null
			? startDelegationLifecycle({
					delegations,
					hc,
					delegationsDir: paths.delegations(),
					homeDir: homedir(),
					...delegationWake(delivery.wakeDeps),
				})
			: null;
	const delegateDeps = makeDelegateDeps({
		config: delegationBoot,
		configRef,
		lifecycle: delegationLifecycle,
		pin: (conv, name) => launchPin(launchPinDeps, conv, name),
	});
	// The one tool factory — the runtime builds the live set per turn
	// through it. The mount policy (which slots exist per
	// channel/config/boot pin) lives in turn-tools.ts; boot binds the
	// seams.
	const makeTurnTools = makeTurnToolsFactory({
		now: wallClock,
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
		t3,
		watches,
		posts,
		asks,
		github,
		mail: mailApproval,
		programApproval,
		visionDepsFor,
		sandboxes,
		desktops,
		agents: agentChildren,
		filterGuests: filterGuestTools,
		// read_file of a catalog SKILL.md is a use — the curator's clock
		// (design/skills.md → Self-authoring, /learn, curator). Only the
		// SKILL.md itself counts: support files ride the body's use.
		noteSkillRead: (abs) => {
			const name = skillUnderPath([paths.skills()], abs);
			if (name === null || abs !== join(paths.skills(), name, "SKILL.md")) return;
			noteSkillUse(paths.skillUsage(), name, new Date());
		},
	});
	// Every tool owner exists past here; the runtime refuses turns before this.
	runtime.mount({ makeTools: makeTurnTools, runOwnership: delivery.dispatcher.hooks });
	agentChildren.recoverAtBoot();
	const watchObserver = makeWatchObserver({
		watches,
		wakes: wakeStore,
		pump: () => delivery.dispatcher.pump(),
		showThread: (thread, messages) => t3.showThread(thread, messages),
		readPr: (repository, number) => github.readPr(repository, number),
		now: wallClock,
	});
	const OBSERVE_MS = 60_000;
	const watchTicker = every(OBSERVE_MS, "watch observe", () => watchObserver.observe(), { unref: true });
	const stopWatchTicker = () => watchTicker.cancel();
	const stopWakeTicker = delivery.dispatcher.start();

	// App auth mode resolves once at boot: appToken set → bearer, unset →
	// trust (the tailnet is the lock); a mid-run flip needs a restart.
	const appTokenName = resolveAppAuth(config.appToken);
	// Boot-pinned blocks: memory binds queue rows to the endpoint+bank hash,
	// delegation/desktops freeze adapters and pool limits at boot,
	// http.port binds the Bun.serve listener, and reviewer wiring is
	// boot-bound — a mid-run change is a warn + restart.
	const bootPins: BootPins = {
		memory: memoryBootConfig,
		appToken: appTokenName,
		telegramEnabled,
		apiRoot: apiRootBoot,
		delegation: delegationBoot,
		desktops: desktopsBoot,
		http: config.http,
		reviewer: config.reviewer,
		system1: config.system1,
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
			const api = attach.api();
			if (api !== null) applyMenuButton(api, configRef.current.publicUrl);
		},
		warnStrandedSandboxes,
	});
	// The operator surface (settings, memory, programs, delegations,
	// status) is one bundle mounted at both doors — the mini app's
	// /api/* (initData) and the app channel's /api/app/* (bearer/trust).
	// http/operator.ts owns the assembly; boot binds configRef and
	// onConfigWritten per door.
	const chatgptLogin = createChatGptLogin({
		config: () => configRef.current,
		// A first sign-in makes ChatGPT usable — providers.codex lands
		// only when no codex provider is configured at all.
		onSignedIn: () => ensureCodexProvider(configRef, onConfigWritten),
	});
	const operatorSeams = makeOperatorSeams({
		store,
		memory,
		...(outageTracker === null ? {} : { memoryOutage: outageTracker }),
		programs,
		delegations,
		skillSources,
		// Temp-skill previews score through the same gate as the mail
		// injection check — absent = the endpoint answers 503.
		...(system1Gate
			? { skillFetch: { gate: system1Gate as Pick<typeof system1Gate, "decide"> } }
			: {}),
		auth,
		paths,
		version: pkg.version,
		startedAt,
		restartHints,
	});
	operatorSeams.chatgpt = chatgptLogin;
	if (delegationLifecycle !== null) {
		operatorSeams.stopDelegation = (id) => delegationLifecycle.stopByOperator(id);
	}
	const appDepsPreLive: Omit<AppChannelDeps, "live"> = {
		store,
		runtime,
		projects,
		notes,
		posts,
		asks,
		agents: agentChildren,
		auth,
		configRef,
		gate: () => system1Gate ?? undefined,
		onConfigWritten,
		// Same seams the mini-app door reads — app-channel mounts
		// them under /api/app/* with the bearer/trust gate.
		operator: operatorSeams,
		// Both doors reach the same durable CAS owners; this route
		// supplies the authenticated app actor, never transport authority.
		approvals: { program: programApproval, mail: mailApproval },
		programOps,
		push: appPush,
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
	};
	const appDeps: AppChannelDeps = { ...appDepsPreLive, live: openAppLive(appDepsPreLive) };
	// The telegram config-disable latch is registered inside
	// openTelegramAttach — at open, still before HTTP can accept a save,
	// even if it arrives before the deferred task starts.
	const http = startHttp({
		configRef,
		...operatorSeams,
		// Late-bound and fail-closed: until the telegram attach lands,
		// mini-app initData has no token to validate against and refuses.
		get botToken() {
			return attach.botToken();
		},
		// POST /hook/<token> — the token is the credential; the webhook
		// entry point owns the fire's accounting (last_run only when landed).
		hooks: {
			programs,
			accepting: () => runtime.accepting(),
			fire: (program, event, now) => fireWebhook(delivery.firingDeps, program, event, now),
		},
		// The loopback /api/runtime/busy door: release.ts's idle wait reads
		// the runtime's lanes through this before restarting.
		busyConversations: () => runtime.busyConversations(),
		// The System One gate doubles as the loopback injection checker — absent = 503.
		...(system1Gate ? { checkInjection: { gate: system1Gate } } : {}),
		// The app handler stays opaque here: app-channel.ts imports the
		// runtime/AI-SDK graph, which must not enter http/mod.ts's DOM-lib
		// typecheck program.
		appApi: (req, url) => handleAppApi(req, url, appTokenName, appDeps),
		onConfigWritten,
	});

	// The scheduler submits through bot.api; the boot scan fires anything
	// missed while down.
	const scheduler = startScheduler(delivery.firingDeps);

	// The mail watcher is the scheduler's twin over gws, handing matches to the
	// mail entry point (which owns checkpoints); always started — it idles
	// without the block.
	const mailWatcher = startMailWatcher({
		programs,
		reader: mailPoller,
		fire: (program, hits, checkpoint, now) =>
			fireMail(delivery.firingDeps, program, hits, checkpoint, now),
		notify: makeMailNoticeRouter({
			sendTelegram: (address, text) => {
				const api = attach.api();
				if (api === null) {
					log.warn(
						telegramEnabled
							? "mail outage notice skipped — telegram channel unavailable"
							: "mail outage notice skipped — telegram channel disabled",
						{ chat: address.chatId, thread: address.threadId },
					);
					return Promise.resolve();
				}
				return sendMailNotice(api, address, text);
			},
		}),
	});

	// ---------- deferred telegram attach ----------
	//
	// The init task kicks only after every core service stands — the app
	// channel, HTTP, the scheduler and the mail watcher must never wait on
	// bot auth. Attach retries with backoff until it lands, the channel
	// seals, or config disables it: the observed boot failure is a wallet
	// or resolver still coming up — environmental, self-healing. A
	// getUpdates ending mid-run (grammy rethrows 401/409) stays a
	// one-shot detach — that death is fatal, not environmental.
	// src/boot/telegram-attach.ts owns the task and shutdown's stop.
	if (telegramEnabled) {
		attach.start({
			auth,
			store,
			runtime,
			journal: turnJournal,
			titleFor,
			transcribe: transcribeFile,
			memory: memorySurfaces,
			gate: system1Gate,
			mailApproval,
			programApproval,
			programs,
			mailLanes,
			rewireWake: delivery.rewireWake,
			tick: () => scheduler.tick(),
			skillSources,
		});
	}

	return {
		configRef,
		auth,
		store,
		programs,
		outbox,
		delegations,
		runtime,
		wakeDispatcher: delivery.dispatcher,
		stopWakeTicker,
		stopWatchTicker,
		// Live over the attach/detach-rebound Telegram adapter — shutdown
		// joins in-flight taps through it without racing a detach that
		// happened after boot returned.
		stopTelegram: attach.stop,
		http,
		scheduler,
		delegationLifecycle,
		mailWatcher,
		mailApproval,
		programApproval,
		stopTelegramProgramApproval: attach.stopProgramApproval,
		memoryWorker,
		desktops,
	};
}

let booted: Awaited<ReturnType<typeof boot>>;
try {
	booted = await boot();
} catch (err) {
	log.error("boot failed", err);
	homeLock.release();
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
	stopWatchTicker,
	stopTelegram,
	http,
	scheduler,
	delegationLifecycle,
	mailWatcher,
	mailApproval,
	programApproval,
	stopTelegramProgramApproval,
	memoryWorker,
} = booted;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	idleCompactor?.stop();
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
	stopWatchTicker();
	// Join any in-flight scan before closing the store; running threads
	// belong to the T3 Code server and resume on next boot.
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
	const settled = Promise.allSettled([
		stopping,
		drained,
		delegationScan,
		mailScan,
		mailSends,
		programJoins,
		telegramProgramJoins,
		retention,
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
	store.close();
	programs.close();
	outbox.close();
	delegations?.close();
	homeLock.release();
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
