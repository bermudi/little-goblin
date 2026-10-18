// Composition root — it wires, it never rules (DESIGN.md → Module map).

import { homedir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import pkg from "../package.json";
import type { MediaPosition } from "./agent/attachments.ts";
import {
	contextLimit,
	ensureOpenRouterCatalog,
	inputModalities,
	inputModalitiesCached,
} from "./agent/models-dev.ts";
import { generateNoteRewrite } from "./agent/note-rewrite.ts";
import { systemPromptFor } from "./agent/prompt.ts";
import {
	cacheRouteFor,
	carriesMedia,
	observedModel,
	resolveModel,
	thinkingOptions,
} from "./agent/providers.ts";
import { makeTitleFor } from "./agent/title.ts";
import { makeTools, toolNames } from "./agent/tools/mod.ts";
import { makePrivateSender } from "./agent/tools/program.ts";
import { withScript } from "./agent/tools/script.ts";
import { makeTranscriber, probeFfmpeg } from "./agent/transcribe.ts";
import { makeVisionDepsFor } from "./agent/vision.ts";
import { whistleArtifactPresence } from "./agent/transcribe-whistle.ts";
import { synthesizeSpeech } from "./agent/tts.ts";
import { appendAuthRecord, loadAuth } from "./auth.ts";
import { openCacheObservation } from "./cache-observation.ts";
import { openCachePruning } from "./cache-pruning.ts";
import {
	type Config,
	type ConfigRef,
	ensureHomeLayout,
	goblinHome,
	loadConfig,
	missingAuthNames,
	paths,
	splitModelRef,
	type ThinkingLevel,
	type TtsConfig,
} from "./config.ts";
import { type BootPins, bootPinnedDiffs } from "./config-pins.ts";
import {
	type Conversation,
	captureConversationSettings,
	channelOf,
	openStore,
	prepareAppSettingsForConfig,
} from "./conversation.ts";
import {
	type DelegationLifecycle,
	type DelegationTargetDeps,
	delegationWake,
	startDelegationLifecycle,
} from "./delegation-lifecycle.ts";
import { openDelegations } from "./delegations.ts";
import { makeDesktops, openDesktops } from "./desktops.ts";
import { makeHerdr, makeOperatorHerdr } from "./herdr.ts";
import { handleAppApi, resolveAppAuth } from "./http/app-channel.ts";
import { startHttp } from "./http/mod.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { type MailPoller, type MailSender, makeSender } from "./mail.ts";
import { makeGwsReader } from "./mail-gws.ts";
import { openOutbox } from "./mail-outbox.ts";
import { startMailWatcher } from "./mail-watcher.ts";
import {
	buildDestinationClient,
	buildMemoryClient,
	type MemoryWorker,
	startMemoryWorker,
} from "./memory/mod.ts";
import { OutageTracker } from "./memory/outage.ts";
import { openNotes } from "./notes.ts";
import { makePodman } from "./podman.ts";
import { openPrograms } from "./programs.ts";
import { openProjects, projectWorkdir } from "./projects.ts";
import { wireReviewer } from "./reviewer.ts";
import { Runtime, type RuntimeDeps } from "./runtime.ts";
import { makeSandboxes, openSandboxes } from "./sandboxes.ts";
import { fireMail, fireWebhook, type SchedulerDeps, startScheduler } from "./scheduler.ts";
import { resolveSkillProposal, type SkillAction } from "./skill-decisions.ts";
import { SkillSources } from "./skill-provenance.ts";
import { launchPin, type SpinOffDeps } from "./spinoff.ts";
import { openSubagentRuns } from "./subagent-runs.ts";
import { openSubagents, type Subagents } from "./subagents/mod.ts";

import { withTimeout } from "./tg/deadline.ts";
import { filterGuestTools } from "./tg/guest.ts";
import { sendMailNotice, startMailApproval } from "./tg/mail-approval.ts";
import { AUTH_TELEGRAM_TOKEN, applyMenuButton, startBot } from "./tg/mod.ts";
import {
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendSkillProposedNotice,
} from "./tg/notify.ts";
import { openPings } from "./tg/pings.ts";
import { sendInterruptedTurnNotices } from "./tg/turn-notice.ts";
import { makeWakeDeps } from "./tg/wake.ts";
import { openTurnJournal } from "./turn-journal.ts";
import { makeResumeOps, type ResumeOps } from "./turn-resume.ts";
import { wakeConversation } from "./wake.ts";

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
// Declared above boot(): the startup-failure cleanup below budgets a
// wedged close with the same constant the shutdown drain uses.
const SHUTDOWN_DRAIN_MS = 10_000;

// Warn-line labels for bootPinnedDiffs keys (config-pins.ts) — the diff
// returns bare keys; the log line names the block.
const PIN_LABEL: Record<string, string> = {
	memory: "memory config",
	delegation: "delegation config",
	subagents: "subagents config",
};

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
	const cacheObservations = openCacheObservation(store.db);
	// The crash journal shares the store's handle like the tg inbox.
	// Its open reclassifies rows left 'running' — a graceful shutdown
	// fences first, so 'running' at open means the process died mid-turn.
	const turnJournal = openTurnJournal(store.db);
	// Between-turns pruning of old textual tool outputs — inert without a
	// hand-edited cachePruning block (DESIGN.md → Cache stability).
	const cachePruning = openCachePruning({
		store,
		observation: cacheObservations,
		getConfig: () => configRef.current,
	});
	// Skill provenance shares the store's SQLite (design/skills.md →
	// Skill provenance): the reviewer and the turn stream record, the
	// operator doors read.
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
		// reset refuses while a lease stands (design/subagents.md).
		runLease: (conv) => subagentRuns.workerLease(conv),
		// Destructive sandbox lifecycle (recreate/restart) reaches the
		// worker on its next tool result — persisted until carried.
		onLifecycle: (conv, note) => subagentRuns.noteLifecycle(conv, note),
	});
	// Removing or emptying the block turns the tool off but never the
	// containers — the idle sweep only rides sandbox calls, and a boot
	// sweep would break the "restarts never kill experiments" ruling
	// (design/sandbox.md). So a disable surfaces the stranded rows and
	// the manual rm line; the operator decides what the containers are.
	const sandboxConfigured = (c: Config) => typeof c.sandbox === "object";
	const warnStrandedSandboxes = () => {
		const rows = sandboxStore.list();
		if (rows.length === 0) return;
		log.warn(
			`sandbox disabled with ${rows.length} tracked container(s) still standing — ` +
				`no sweep will fire while the block is absent. Remove them: ` +
				`podman rm -f ${rows.map((r) => r.container).join(" ")}`,
			{ containers: rows.map((r) => r.container) },
		);
	};
	if (!sandboxConfigured(config)) warnStrandedSandboxes();
	// Split mail authority: gws polling serves the watcher, the send client
	// only approval taps — gws owns its own auth, no OAuth secret here.
	const mailPoller = (): MailPoller | null => {
		const m = configRef.current.mail;
		if (!m) return null;
		return makeGwsReader();
	};
	const mailSender = (): MailSender | null => {
		const m = configRef.current.mail;
		if (!m) return null;
		return makeSender({
			auth,
			clientId: m.clientId,
			clientSecretAuth: m.clientSecretAuth,
			sendAuth: m.sendAuth,
		});
	};
	// Delegation is boot-fixed like memory — the session is systemd's, not
	// ours.
	const delegationBoot = config.delegation;
	const delegations = delegationBoot ? openDelegations(paths.db()) : null;
	// "goblin" is the local unit's --session — the default target, never a config knob.
	const herdr = delegationBoot ? makeHerdr({ session: "goblin" }) : null;
	// The operator's own `default` session needs no delegation config —
	// the herdr tool mounts for every personal conversation (guest
	// surfaces lose it in filterGuestTools).
	const operatorHerdr = makeOperatorHerdr();
	const delegationTargets = new Map<string, DelegationTargetDeps>();
	if (delegationBoot && herdr !== null) {
		for (const [label, t] of Object.entries(delegationBoot.machines ?? {})) {
			delegationTargets.set(label, {
				...(t.machine !== undefined ? { machine: t.machine } : { session: t.session! }),
				...(t.root !== undefined ? { root: t.root } : {}),
				herdr: makeHerdr(
					t.machine !== undefined ? { machine: t.machine } : { session: t.session! },
				),
			});
		}
	}

	// ---------- the wire step ----------
	//
	// Two construction cycles force late binding: the runtime's tools
	// reach the delegation lifecycle, whose wakes need bot.api — which
	// needs the bot, whose intake needs the runtime; and the retention
	// worker's notices need bot.api while the memory surfaces quiesce
	// through it. completeBoot() below is the one fill point, before
	// replayInbox (the first await after startBot) — an unwired read past
	// it is a boot-order bug.

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

	// The delegate tool's per-turn deps: a live config read hides the tool
	// next turn while the lifecycle keeps tracking owned rows; config stays
	// the boot snapshot — a live definition could send a new launch's paths
	// into the old adapter's session (spinoff.ts owns the pin).
	const delegateDeps = (conv: Conversation, workdir: string) => {
		if (
			delegationBoot === undefined ||
			configRef.current.delegation === undefined ||
			delegations === null ||
			herdr === null
		) {
			return undefined;
		}
		return {
			lifecycle: late().delegationLifecycle(),
			config: delegationBoot,
			// Relative cwd in delegation harness args anchors at the turn's
			// working directory — under a project that's the project's dir.
			workspaceDir: workdir,
			pin: (name: string) => launchPin(launchPinDeps, conv, name),
		};
	};

	// Probe ffmpeg at boot: TTS is default-on with ffmpeg as its only
	// dependency — a missing binary takes TTS down for the run instead of
	// failing per message; transcription needs it only over the upload cap
	// (for the wav-profile kinds, always — whistle's ogg→wav decode,
	// mimo's wav-only input contract).
	if (config.transcription || config.tts) {
		const wavKind =
			config.transcription?.kind === "whistle" || config.transcription?.kind === "mimo"
				? config.transcription.kind
				: undefined;
		const feature = config.tts
			? "tts"
			: wavKind !== undefined
				? `transcription (${wavKind})`
				: "transcription";
		// Edge's remux is a stream copy; the cloud kinds' mp3 must
		// re-encode to opus, so a binary without libopus would die per
		// chunk.
		const ok = await probeFfmpeg(
			feature,
			config.tts !== false && config.tts !== undefined && config.tts.kind !== "edge"
				? "libopus"
				: undefined,
		);
		if (!ok && config.tts) {
			configRef.ttsDown = true;
			log.warn(
				"tts disabled — ffmpeg not found on PATH; install ffmpeg and restart to enable voice replies",
			);
		}
	}
	if (config.transcription) {
		const tr = config.transcription;
		log.info("transcription enabled", {
			kind: tr.kind,
			...(tr.kind === "whistle" ? whistleArtifactPresence(tr) : { model: tr.model, auth: tr.auth }),
		});
	}

	// Warm the openrouter catalog so thinking options and the mini app
	// see real levels, not the cold-start fallback.
	void ensureOpenRouterCatalog();

	// Long-term memory is a boot-time snapshot — queue rows bind to the
	// endpoint+bank hash, so mini-app edits apply on restart, never mid-run.
	const memoryBootConfig = config.memory;
	const memoryClient = buildMemoryClient(memoryBootConfig ?? undefined, auth);
	const memoryState = { lastRecallOk: null as boolean | null, lastRecallAt: null as string | null };
	// Recall telemetry for /memory status — one closure serves both recall paths.
	const noteRecall = (ok: boolean): void => {
		memoryState.lastRecallOk = ok;
		memoryState.lastRecallAt = new Date().toISOString();
	};
	if (memoryClient && memoryBootConfig) {
		// Destination history (#87): each boot's destination is recorded so
		// /forget reconstructs the owning client after a change.
		store.memoryDestinations.record(memoryBootConfig);
		log.info("memory enabled", {
			baseUrl: memoryBootConfig.baseUrl,
			bank: memoryBootConfig.bankId,
		});
	}

	// The project domain — the retention outbox rides along whether or
	// not a memory client exists: pending rows can survive a disable,
	// and project→off must still purge them like /memory off
	// (design/projects.md). Submission needs the client; purging does not.
	const projects = openProjects(store, { memoryQueue: store.memoryQueue });

	// A bound conversation's working directory is its project's dir —
	// the throw inside is a failed turn at admission, never a silent
	// fall-back to the workspace (design/projects.md).
	const workdirFor = (conv: Conversation): string => projectWorkdir(projects, conv);

	// The notes surface (design/projects.md → Notes) — one store for
	// the tool, the app routes, and the project prompt's index.
	const notes = openNotes(store, { projects });

	// Per-call seams for voice notes and the vision gate — the policies
	// live in the agent modules; boot only binds configRef/auth.
	const transcribeFile = makeTranscriber({ configRef, auth });
	const visionDepsFor = makeVisionDepsFor({ configRef, auth, observation: cacheObservations });

	// The one tool factory — the runtime builds the live set per turn
	// through it, and the resume contract check (turn-resume.ts)
	// rebuilds the surface through the same closure so the drift
	// comparison reads the set the resumed attempt would actually get.
	const makeTurnTools: RuntimeDeps["makeTools"] = (
		conv,
		deliverVoice,
		recording,
		deliverFile,
		accepts,
	) => {
		const tts = configRef.current.tts;
		// Telegram-bound tools don't register on app turns — disjoint
		// pools (DESIGN.md → App channel); delegate is the exception
		// since the spin-off.
		const telegram = channelOf(conv.id) === "telegram";
		// One resolution feeds bash/fetch/read_file's cwd, the sandbox's
		// relative-path anchor, and delegation's workspaceDir — a
		// project conversation works in its dir end to end; a vanished
		// dir throws here and the turn fails at admission.
		const workdir = workdirFor(conv);
		const tools = makeTools({
			cwd: workdir,
			voice:
				tts && !configRef.ttsDown && deliverVoice
					? {
							// A per-call voice replaces the config voice outright — Edge
							// derives the language from the voice name; the allowlist
							// always carries the default. The cast is edge-only:
							// openrouter voice ids carry no language to match on.
							synthesize: (text, voice) =>
								synthesizeSpeech(
									text,
									voice !== undefined && tts.kind === "edge" ? { ...tts, voice, voices: [] } : tts,
									{ auth },
								),
							deliver: deliverVoice,
							...(recording ? { recording } : {}),
							...(tts.kind === "edge" && tts.voices?.length
								? { voices: [...new Set([tts.voice, ...tts.voices])] }
								: {}),
						}
					: undefined,
			// sendPrivate keeps hook URLs out of model context — a DM per
			// operator, never in history. publicUrl reads live.
			program: telegram
				? {
						programs,
						chatId: conv.chatId,
						threadId: conv.threadId,
						publicUrl: () => configRef.current.publicUrl,
						sendPrivate: makePrivateSender(
							// The one send composed outside tg/ — same deadline as
							// every tg/ sender, or a wedged API stalls the
							// program turn's tool call forever.
							(id, text) => withTimeout(tg.bot.api.sendMessage(id, text), "sendMessage"),
							() => configRef.current.operators,
						),
					}
				: undefined,
			file: deliverFile ? { deliver: deliverFile } : undefined,
			memory:
				memoryClient && memoryBootConfig
					? {
							client: memoryClient,
							maxTokens: memoryBootConfig.searchMaxTokens,
							budget: memoryBootConfig.searchBudget,
							timeoutMs: memoryBootConfig.searchTimeoutMs,
							minScores: memoryBootConfig.searchMinScores,
							preferObservations: memoryBootConfig.preferObservations,
							reflection: {
								maxTokens: memoryBootConfig.reflectMaxTokens,
								budget: memoryBootConfig.reflectBudget,
								timeoutMs: memoryBootConfig.reflectTimeoutMs,
							},
							isExcluded: () => conv.memoryExcluded,
							noteRecall,
						}
					: undefined,
			// fetch is local (always on), search behind its config block —
			// both read configRef live; the accepts ref rides for PDF rendering.
			web: { configRef, auth, ...(accepts ? { accepts } : {}) },
			transcribe:
				configRef.current.transcription !== undefined ? { transcribe: transcribeFile } : undefined,
			// Boot fixtures under a live gate (see delegateDeps above).
			delegate: delegateDeps(conv, workdir),
			// Unconditional — the operator's session isn't config-gated
			// (guests are filtered below, script's allowlist excludes it).
			herdr: { herdr: operatorHerdr },
			// Only the approval gate's request closure — the send credential lives behind the taps.
			mail:
				telegram && configRef.current.mail !== undefined
					? {
							requestDraft: (input) =>
								mailApproval.requestDraft(input, {
									chatId: conv.chatId,
									threadId: conv.threadId,
								}),
						}
					: undefined,
			history: { store, conversationId: conv.id, isExcluded: () => conv.memoryExcluded },
			// Notes mount for every operator conversation — guests are
			// excluded by the filter below, never by dep absence.
			note: { notes, projects, conversation: conv.id, projectId: conv.projectId },
			// Threads are process-global; a model change drops them on the next call.
			vision: visionDepsFor(conv),
			// Same live-read gate as vision — the image block mounts
			// generate_image; Telegram channels deliver each image
			// inline, other channels save + report paths.
			image:
				configRef.current.image !== undefined
					? {
							configRef,
							auth,
							conversation: conv.id,
							...(deliverFile ? { deliver: deliverFile } : {}),
						}
					: undefined,
			// Live-read like vision/search: the sandbox block mounts the
			// tool for any channel (guest personas are filtered out below).
			sandbox:
				configRef.current.sandbox !== undefined
					? {
							conversation: conv.id,
							workspace: workdir,
							sandboxes,
						}
					: undefined,
			// The subagents block is boot-frozen — a live config read
			// can only hide the tools, never swap models mid-run.
			subagent:
				subagents !== null && configRef.current.subagents !== undefined
					? {
							conversation: conv.id,
							workspace: workdir,
							subagents,
							workerEnabled:
								subagentsBoot?.worker !== undefined && configRef.current.sandbox !== undefined,
							computerEnabled: subagentsBoot?.computer !== undefined,
						}
					: undefined,
			desktop:
				subagents !== null && desktops !== null && configRef.current.subagents !== undefined
					? { conversation: conv.id, workspace: workdir, desktops }
					: undefined,
			// The interface tool mounts on app turns only — Telegram
			// and guests render plain text (design/app.md → Intelligent UI).
			ui: channelOf(conv.id) === "app",
		});
		// Guest mode: hard toolset exclusion after assembly (design/telegram.md → Guest mode).
		const filtered = filterGuestTools(conv, tools);
		// script composes the filtered set; refiltering keeps it out of the guest persona's allowlist.
		const scripting = configRef.current.scripting;
		return scripting
			? filterGuestTools(
					conv,
					withScript(filtered, {
						conversation: conv.id,
						maxCalls: scripting.maxCalls ?? 50,
					}),
				)
			: filtered;
	};

	const runtime = new Runtime({
		store,
		turnJournal,
		captureConversation: (conv) => captureConversationSettings(store, conv, configRef.current),
		pruneBetweenTurns: (convId) => {
			cachePruning.pruneConversation(convId);
		},
		async buildStep(conv, tools) {
			const cfg = configRef.current;
			const modelRef = conv.model!;
			const { provider, modelId } = splitModelRef(modelRef);
			// Auth "!command" and the catalog fetch may both be slow — run in parallel.
			const [model, modalities, contextWindow] = await Promise.all([
				resolveModel(cfg, auth, modelRef),
				inputModalities(provider, modelId),
				contextLimit(provider, modelId),
			]);
			// The pipe gate is what the provider's SDK converter can deliver — catalog
			// truth alone once cost a thrown turn (openai-compatible < v3 rejected
			// allowed file parts).
			const kind = cfg.providers[provider]?.kind;
			const carries = (mediaType: string, position: MediaPosition): boolean =>
				carriesMedia(kind ?? "", mediaType, position);
			const level = conv.thinking as ThinkingLevel;
			const providerOptions = thinkingOptions(cfg, modelRef, level);
			const project = conv.projectId === null ? null : projects.get(conv.projectId);
			const prompt = systemPromptFor(
				store,
				conv,
				toolNames(tools),
				project,
				project === null ? undefined : notes.index(project.id),
			);
			log.info("model step", {
				conversation: conv.id,
				model: modelRef,
				thinking: level,
				prompt: prompt.sources.join("+"),
			});
			return {
				// Observed at the model boundary — tool-loop continuations included.
				model: observedModel(model, {
					conversation: conv.id,
					observation: cacheObservations,
					route: cacheRouteFor(cfg, modelRef),
				}),
				system: prompt.text,
				label: modelRef,
				inputModalities: modalities,
				carries,
				...(contextWindow !== null ? { contextWindow } : {}),
				...(providerOptions ? { providerOptions } : {}),
			};
		},
		// Compaction: the conversation's own model, plain generate, no tools (DESIGN.md → Compaction).
		compaction: {
			modelRef: (conv) => conv.model!,
			summarize: async (conv, system, prompt, signal) => {
				const cfg = configRef.current;
				const modelRef = conv.model!;
				const model = observedModel(await resolveModel(cfg, auth, modelRef), {
					conversation: conv.id,
					purpose: "compaction",
					observation: cacheObservations,
					route: cacheRouteFor(cfg, modelRef),
				});
				const providerOptions = thinkingOptions(cfg, modelRef, conv.thinking as ThinkingLevel);
				const { text } = await generateText({
					model,
					instructions: system,
					prompt,
					abortSignal: signal,
					...(providerOptions ? { providerOptions } : {}),
				});
				return text;
			},
		},
		makeTools: makeTurnTools,
		...(memoryClient && memoryBootConfig
			? {
					memory: {
						client: memoryClient,
						config: memoryBootConfig,
						contexts: store.memoryContexts,
						noteRecall,
					},
				}
			: {}),
	});

	// One titler for both channels — implicit topics and app first-turn naming.
	const titleFor = makeTitleFor({ configRef, auth, observation: cacheObservations });
	const launchPinDeps: SpinOffDeps = {
		store,
		titleFor,
		publicUrl: () => configRef.current.publicUrl || undefined,
		appDefaults: () => configRef.current,
	};

	// The memory surfaces every door answers from (bot commands, mini app
	// status + browser); the worker seam reads through the wire step — built
	// after the bot.
	const memorySurfaces =
		memoryClient === null
			? null
			: {
					client: memoryClient,
					clientForTarget: (target: string) => {
						const destination = store.memoryDestinations.get(target);
						return destination === null ? null : buildDestinationClient(destination, auth);
					},
					contexts: store.memoryContexts,
					queue: store.memoryQueue,
					lastRecallOk: () => memoryState.lastRecallOk,
					lastRecallAt: () => memoryState.lastRecallAt,
					withWorkerPaused: <T>(fn: () => Promise<T>): Promise<T> => late().retention(fn),
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
	const tg = await startBot({
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
		mail: () => mailApproval,
		followUpGate: () => system1Gate ?? undefined,
		resumeOps: () => resumeOps,
	});

	// The mail approval gate — the draft's one owner (queue → post →
	// bind; taps; expiry sweep). Always started: orphaned drafts still settle.
	const mailApproval = startMailApproval({
		api: tg.bot.api,
		outbox,
		sender: mailSender,
		reader: mailPoller,
	});

	// The retention worker runs after the bot — outage and blocked
	// notices deliver through bot.api (one per episode / per document).
	const memoryWorker = memoryClient
		? startMemoryWorker(store.memoryQueue, memoryClient, {
				outage: {
					tracker: new OutageTracker(store.db),
					notify: (conversationId, sinceMs, queued) =>
						sendMemoryOutageNotice(tg.bot.api, conversationId, sinceMs, queued),
				},
				blocked: {
					notify: (conversationId, error, attempts) =>
						sendMemoryBlockedNotice(tg.bot.api, conversationId, error, attempts),
				},
			})
		: null;

	// The skill reviewer runs after the bot (save notes deliver through
	// bot.api); reviewer.ts owns the gate construction, threshold merge and
	// live review-model resolution — boot binds the seams it can't own.
	const { gate: system1Gate, reviewer: skillReviewer } = wireReviewer({
		configRef,
		auth,
		store,
		observation: cacheObservations,
		paths,
		notify: (conversationId, skills) => sendSkillProposedNotice(tg.bot.api, conversationId, skills),
		recordSources: (conversationId, reviewId, skills) => {
			for (const skill of skills)
				skillSources.record(conversationId, skill, "reviewer", undefined, reviewId);
		},
	});
	if (system1Gate !== null) {
		// The loop watchdog rides the same System1Client (design/model.md → "No step
		// budget"): every 16 completed calls system1 scores the digest ring — warn
		// once, cut on the second stuck verdict.
		runtime.setLoopWatchdog({ decide: system1Gate.decide.bind(system1Gate) });
	}
	if (skillReviewer !== null) runtime.setReviewer(skillReviewer);

	// The shared wake path — program fires and delegation notices submit
	// through it; wake.ts owns the routing. Intake opens its own pings handle
	// inside createBot.
	const pings = openPings(store.db);
	const wakeDeps = makeWakeDeps({
		store,
		runtime,
		api: tg.bot.api,
		configRef,
		synthesize: (text: string, tts: TtsConfig) => synthesizeSpeech(text, tts, { auth }),
		followUpGate: () => system1Gate ?? undefined,
		pings,
	});

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
		sinkFor: (conv) =>
			channelOf(conv.id) === "app" ? wakeDeps.bell(conv) : wakeDeps.delivery(conv),
		sinkHooks: (conv) =>
			channelOf(conv.id) === "app"
				? { voice: false, recording: false, file: false }
				: { voice: true, recording: true, file: true },
		notifyDone: (conv, sourceRunId, done) => {
			if (channelOf(conv.id) === "app") return; // the bell is already the notice
			const text =
				`resumed turn ${sourceRunId.slice(0, 8)} in ${conv.title ?? conv.id}: ${done.kind}` +
				(done.kind === "error" ? ` — ${done.message}` : "");
			for (const chat of configRef.current.operators) {
				void withTimeout(
					tg.bot.api.sendMessage(chat, text),
					"sendMessage (resumed turn notice)",
				).catch((err: unknown) => {
					log.warn("resumed turn notice failed", {
						conversation: conv.id,
						chat,
						error: String(err),
					});
				});
			}
		},
	});
	const firingDeps: SchedulerDeps = {
		...wakeDeps,
		programs,
		// The System One gate doubles as the watcher-event scorer (fail-open) — unscored absent.
		...(system1Gate ? { checkMail: system1Gate as Pick<typeof system1Gate, "decide"> } : {}),
	};

	// The delegation lifecycle — after tg (notices wake through bot.api),
	// before replayInbox (the first await after startBot): the wire step
	// lands before any turn.
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
	// A poisoned auth record or a resume refusal (e.g. a lowered
	// maxRuns) must not crash-loop the service — poison the feature,
	// never refuse boot (auth.ts). The pool stays constructed but
	// every subagent/desktop tool is gated on the owner, so a failed
	// open unmounts both for the run.
	let subagents: Subagents | null = null;
	if (subagentsBoot !== undefined && desktops !== null) {
		try {
			subagents = await openSubagents({
				config: subagentsBoot,
				runs: subagentRuns,
				auth,
				sandboxes,
				desktops,
				storagePath: join(paths.state(), "subagents.sqlite"),
				transferRoot: join(paths.state(), "subagent-transfer"),
				wake: (conv, text) => wakeConversation(wakeDeps, conv, text),
			});
			// Recovery is explicit and ordered: persisted stops land,
			// desktop leases re-verify and monitors reattach BEFORE the
			// harness resumes scheduling — and before any inbound
			// message can reach the tools.
			await subagents.resume();
		} catch (err) {
			log.error("subagents startup failed — closing the owner before disabling", err);
			if (subagents !== null) {
				// close() on a half-open owner can itself throw, or wedge
				// on a lane/monitor promise that never settles — either
				// would turn the fail-open catch into the boot failure it
				// exists to prevent. Same best-effort budget as the
				// shutdown drain: join it if it lands, disable anyway.
				const closed = subagents
					.close()
					.then(() => true)
					.catch((closeErr: unknown) => {
						log.warn("subagents close after failed startup threw — disabling anyway", closeErr);
						return false;
					});
				const joined = await Promise.race([closed, sleep(SHUTDOWN_DRAIN_MS).then(() => false)]);
				if (!joined) {
					log.warn("subagents close after failed startup wedged — disabling anyway", {
						budgetMs: SHUTDOWN_DRAIN_MS,
					});
				}
			}
			subagents = null;
			log.error("subagents disabled — owner failed to open; fix the block and restart", err);
		}
	}

	// The crash journal's boot notice (design/runtime-turn.md → The turn
	// journal): rows reclassified 'interrupted' at open get one DM per
	// operator — terse facts, never a replay. A failed send must not hold
	// boot; the log line is the record.
	sendInterruptedTurnNotices(
		tg.bot.api,
		turnJournal.interruptedAtOpen,
		configRef.current.operators,
		(id) => store.get(id)?.title ?? undefined,
	);

	// Recover inbox rows before polling: the wirings above must exist before
	// recovered turns run, and the offset must not advance past journaled input.
	await tg.replayInbox();
	tg.startPolling();

	// Search/transcription flips redraw the registered tool set — a cache
	// boundary (DESIGN.md → Web access) — so each flip gets its own log line.
	let searchInSet = config.search !== undefined;
	let transcribeInSet = config.transcription !== undefined;
	let sandboxInSet = sandboxConfigured(config);
	// App auth mode resolves once at boot: appToken set → bearer, unset →
	// trust (the tailnet is the lock); a mid-run flip needs a restart.
	const appTokenName = resolveAppAuth(config.appToken);
	// Boot-pinned blocks: memory binds queue rows to the endpoint+bank hash,
	// delegation/subagents freeze adapters and pool limits at boot — a
	// mid-run change is a warn + restart (config-pins.ts owns the diff).
	const bootPins: BootPins = {
		memory: memoryBootConfig,
		appToken: appTokenName,
		apiRoot: apiRootBoot,
		delegation: delegationBoot,
		subagents: subagentsBoot,
	};
	// One post-write path for every config door: hot-apply what's live,
	// warn on what's boot-pinned.
	const onConfigWritten = () => {
		setLogLevel(configRef.current.logLevel);
		// publicUrl is operator-editable — keep the menu button in sync without a restart.
		applyMenuButton(tg.bot.api, configRef.current.publicUrl);
		const searchNow = configRef.current.search !== undefined;
		if (searchNow !== searchInSet) {
			log.info(
				searchNow
					? "search tool enabled — joins the set next turn"
					: "search tool disabled — leaves the set next turn",
			);
			searchInSet = searchNow;
		}
		const transcribeNow = configRef.current.transcription !== undefined;
		if (transcribeNow !== transcribeInSet) {
			log.info(
				transcribeNow
					? "transcribe tool enabled — joins the set next turn"
					: "transcribe tool disabled — leaves the set next turn",
			);
			transcribeInSet = transcribeNow;
		}
		const sandboxNow = sandboxConfigured(configRef.current);
		if (sandboxInSet && !sandboxNow) warnStrandedSandboxes();
		sandboxInSet = sandboxNow;
		// Memory is a boot-time snapshot (queue rows bind to the endpoint+bank
		// hash); delegation and subagents are boot-frozen adapters and pool
		// limits — all warned by the shared pin diff.
		for (const key of bootPinnedDiffs(bootPins, configRef.current)) {
			log.warn(`${PIN_LABEL[key] ?? key} changed — restart to apply`);
		}
	};
	// The same boot-pin comparisons onConfigWritten logs — the operator
	// surface's status card answers with them instead of waiting for the
	// operator to notice a warn line.
	const restartHints = (): string[] => bootPinnedDiffs(bootPins, configRef.current);
	// The operator surface (settings, memory, programs, delegations,
	// status) is one bundle mounted at both doors — the mini app's
	// /api/* (initData) and the app channel's /api/app/* (bearer/trust).
	const operatorSeams = {
		beforeConfigWritten: (previous: Config, next: Config) =>
			prepareAppSettingsForConfig(store, previous, next),
		// Same memory surfaces the /memory command reads, bound to the boot-time target.
		...(memorySurfaces
			? {
					memory: {
						...memorySurfaces,
						...(memoryBootConfig
							? {
									target: {
										baseUrl: memoryBootConfig.baseUrl,
										bankId: memoryBootConfig.bankId,
									},
								}
							: {}),
						counts: () => store.memoryQueue.counts(memorySurfaces.client.target),
						deletingAll: () => store.memoryQueue.deletingCount(),
						blockedDetail: () => store.memoryQueue.blockedDetail(memorySurfaces.client.target),
					},
				}
			: {}),
		programs,
		delegations,
		service: { version: pkg.version, startedAt, restartHints },
		authNames: () => auth.names(),
		// Settings' "+ key" affordance — the record appends to auth.jsonl
		// (durable, 0600) then lands in the live store, so a pasted key
		// resolves without a restart.
		secrets: {
			has: (name: string) => auth.has(name),
			isCommand: (name: string) => auth.isCommand(name),
			store: (name: string, value: string) => {
				appendAuthRecord(paths.auth(), name, value);
				auth.put(name, value);
			},
		},
		skillSources: {
			forConversation: (conversationId: string) => skillSources.forConversation(conversationId),
			skillsDir: paths.skills(),
			proposedDir: paths.skillsProposed(),
		},
		// The operator doors' ✅/🚫 — same mechanics the Telegram row
		// runs, plus the resolution event into the learning conversation
		// (provenance's newest row) when there is one.
		skillDecisions: {
			decide: (skill: string, action: SkillAction) =>
				resolveSkillProposal(
					{
						workspaceDir: paths.workspace(),
						skillsDir: paths.skills(),
						proposedDir: paths.skillsProposed(),
						forSkill: (s: string) => skillSources.forSkill(s),
						store,
					},
					skill,
					action,
				),
		},
	};
	const http = startHttp({
		configRef,
		...operatorSeams,
		botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
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
				// Same intake seam as the tg lane — speech uploads transcribe before submit.
				transcribe: transcribeFile,
				// Null = unconfigured or ffmpeg-down — the endpoint answers 503
				// rather than failing mid-synthesis.
				speak: async (text) => {
					const tts = configRef.current.tts;
					if (!tts || configRef.ttsDown) return null;
					return synthesizeSpeech(text, tts, { auth });
				},
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
		notify: (address, text) => sendMailNotice(tg.bot.api, address, text),
	});

	return {
		configRef,
		auth,
		store,
		programs,
		outbox,
		delegations,
		runtime,
		tg,
		http,
		scheduler,
		delegationLifecycle,
		mailWatcher,
		mailApproval,
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
	tg,
	http,
	scheduler,
	delegationLifecycle,
	mailWatcher,
	mailApproval,
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
	// Join any in-flight scan before closing the store; running agents
	// belong to herdr and resume on next boot.
	const delegationScan = delegationLifecycle?.stopTicker() ?? Promise.resolve();
	// The mail watcher stops polling and joins an in-flight scan — a late
	// fire must not land in a closed runtime; cursors and drafts persist.
	const mailScan = mailWatcher.stop();
	// The approval gate stops sweeping AND joins an in-flight Gmail send
	// bounded by the drain budget below.
	const mailSends = mailApproval.stop();
	// The retention worker aborts its in-flight request and yields — the
	// outbox rows stay durable for the next boot. Joined under the budget
	// like everything else: a wedged memory service is not a deploy hold.
	const retention = memoryWorker?.stop() ?? Promise.resolve();
	// bot.stop confirms the polling offset so handled updates don't
	// redeliver on the next boot.
	const stopping = tg.bot.stop().catch((err: unknown) => {
		log.warn("bot stop failed", err);
	});
	// Close the runtime first — intake that lands during the drain still
	// reaches history but never starts a turn.
	const drained = runtime.shutdown();
	const flushed = tg.drainIntake();
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
		flushed,
		delegationScan,
		mailScan,
		mailSends,
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
