// Composition root — it wires, it never rules (DESIGN.md → Module map).

import { homedir } from "node:os";
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
import { join } from "node:path";
import { systemPromptFor } from "./agent/prompt.ts";
import { carriesMedia, observedModel, resolveModel, thinkingOptions } from "./agent/providers.ts";
import { generateTopicTitle } from "./agent/title.ts";
import { makeTools, toolNames, type VisionToolDeps } from "./agent/tools/mod.ts";
import { makePrivateSender } from "./agent/tools/program.ts";
import { withScript } from "./agent/tools/script.ts";
import { probeFfmpeg, speechEngine, transcribeAudio } from "./agent/transcribe.ts";
import { whistleArtifactPresence } from "./agent/transcribe-whistle.ts";
import { synthesizeSpeech } from "./agent/tts.ts";
import { loadAuth } from "./auth.ts";
import {
	type Config,
	type ConfigRef,
	ensureHomeLayout,
	goblinHome,
	loadConfig,
	paths,
	splitModelRef,
	type ThinkingLevel,
	type TtsConfig,
} from "./config.ts";
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
import { makeHerdr } from "./herdr.ts";
import { handleAppApi, resolveAppAuth } from "./http/app-channel.ts";
import { startHttp } from "./http/mod.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { type MailPoller, type MailSender, makeSender } from "./mail.ts";
import { makeGwsReader } from "./mail-gws.ts";
import { openOutbox } from "./mail-outbox.ts";
import { startMailWatcher } from "./mail-watcher.ts";
import { makePodman } from "./podman.ts";
import { openPrograms } from "./programs.ts";
import { openNotes } from "./notes.ts";
import { openProjects, projectWorkdir } from "./projects.ts";
import { makeDesktops, openDesktops } from "./desktops.ts";
import { openSubagentRuns } from "./subagent-runs.ts";
import { openSubagents, type Subagents } from "./subagents.ts";
import {
	buildDestinationClient,
	buildMemoryClient,
	type MemoryWorker,
	startMemoryWorker,
} from "./memory.ts";
import { OutageTracker } from "./memory-outage.ts";
import { wakeConversation } from "./wake.ts";
import { cleanupStaging, Reviewer } from "./reviewer.ts";
import { Runtime } from "./runtime.ts";
import { makeSandboxes, openSandboxes } from "./sandboxes.ts";
import { fireMail, fireWebhook, type SchedulerDeps, startScheduler } from "./scheduler.ts";
import { launchPin, type SpinOffDeps } from "./spinoff.ts";
import { System1Client } from "./system1.ts";
import { filterGuestTools } from "./tg/guest.ts";
import { withTimeout } from "./tg/deadline.ts";
import { sendMailNotice, startMailApproval } from "./tg/mail-approval.ts";
import { AUTH_TELEGRAM_TOKEN, applyMenuButton, startBot } from "./tg/mod.ts";
import {
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendSkillProposedNotice,
} from "./tg/notify.ts";
import { openPings } from "./tg/pings.ts";
import { makeWakeDeps } from "./tg/wake.ts";

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
	const store = openStore(paths.db());
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
	const sandboxes = makeSandboxes({
		podman,
		store: openSandboxes(paths.db()),
		config: () => configRef.current.sandbox,
		// A live worker run pins its sandbox: the reaper skips it and
		// reset refuses while a lease stands (design/subagents.md).
		runLease: (conv) => subagentRuns.workerLease(conv),
		// Destructive sandbox lifecycle (recreate/restart) reaches the
		// worker on its next tool result — persisted until carried.
		onLifecycle: (conv, note) => subagentRuns.noteLifecycle(conv, note),
	});
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
	// (for whistle, always — it is the ogg→wav decoder).
	if (config.transcription || config.tts) {
		const feature = config.tts
			? "tts"
			: config.transcription?.kind === "whistle"
				? "transcription (whistle)"
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

	// Read per call — a mini-app save applies to the next voice note.
	const transcribeFile = async (file: Parameters<typeof transcribeAudio>[1]) => {
		const cfg = configRef.current.transcription;
		if (!cfg) return null;
		return transcribeAudio(speechEngine(cfg, auth), file);
	};

	// The vision tool's per-turn gate (design/tools.md → Vision): "auto"
	// registers it only while the chat model can't consume images (catalog
	// AND pipe gates — cold counts as blind); "always" keeps it — a file
	// on disk is invisible regardless.
	const visionDepsFor = (conv: Conversation): VisionToolDeps | undefined => {
		const cfg = configRef.current;
		if (!cfg.vision) return undefined;
		if (cfg.vision.mode !== "always") {
			const { provider, modelId } = splitModelRef(conv.model!);
			const mods = inputModalitiesCached(provider, modelId);
			const kind = cfg.providers[provider]?.kind ?? "";
			if (mods !== null && mods.has("image") && carriesMedia(kind, "image/jpeg", "user")) {
				return undefined;
			}
		}
		return { configRef, auth, conversation: conv.id };
	};

	const runtime = new Runtime({
		store,
		captureConversation: (conv) => captureConversationSettings(store, conv, configRef.current),
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
				model: observedModel(model, { conversation: conv.id }),
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
		makeTools: (conv, deliverVoice, recording, deliverFile, accepts) => {
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
										voice !== undefined && tts.kind === "edge"
											? { ...tts, voice, voices: [] }
											: tts,
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
					configRef.current.transcription !== undefined
						? { transcribe: transcribeFile }
						: undefined,
				// Boot fixtures under a live gate (see delegateDeps above).
				delegate: delegateDeps(conv, workdir),
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
		},
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
	const titleFor = async (text: string): Promise<string | null> => {
		const cfg = configRef.current;
		if (!cfg.titleModel) return null;
		const model = await resolveModel(cfg, auth, cfg.titleModel);
		return generateTopicTitle(
			observedModel(model, { purpose: "topic-title" }),
			text,
			thinkingOptions(cfg, cfg.titleModel, "off"),
		);
	};
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
	// bot.api); the hand-edited block boot-captures auth and threshold, the
	// review model resolves live.
	const reviewerBlock = configRef.current.reviewer;
	// System One is its own switch (design/system1.md → Config): the shared
	// client exists whenever a `system1` block is set, and `reviewer` still
	// implies it — reviewer configs behave identically; a system1-only
	// config gains the client it already named.
	const system1Block = configRef.current.system1;
	const system1Gate =
		system1Block || reviewerBlock
			? new System1Client({
					auth: () => {
						// Auth resolves live per call; system1.auth wins,
						// reviewer.auth is the fallback for reviewer-only configs.
						const name = configRef.current.system1?.auth ?? reviewerBlock?.auth;
						if (name === undefined) throw new Error("system1 gate without auth");
						return auth.resolve(name);
					},
					...(system1Block?.model !== undefined ? { model: system1Block.model } : {}),
					...(system1Block?.baseUrl !== undefined ? { baseUrl: system1Block.baseUrl } : {}),
				})
			: null;
	if (system1Gate !== null) {
		// The loop watchdog rides the same System1Client (design/model.md → "No step
		// budget"): every 16 completed calls system1 scores the digest ring — warn
		// once, cut on the second stuck verdict.
		runtime.setLoopWatchdog({ decide: system1Gate.decide.bind(system1Gate) });
		if (reviewerBlock === undefined)
			log.info("system1 enabled", {
				model: system1Block?.model,
				baseUrl: system1Block?.baseUrl,
			});
	}
	if (reviewerBlock !== undefined && system1Gate !== null) {
		// reviewer implies the gate by construction — system1Gate is never null here.
		const block = reviewerBlock;
		const thresholds = {
			correction: block.thresholds?.correction ?? block.threshold,
			procedure: block.thresholds?.procedure ?? block.threshold,
		};
		log.info("reviewer enabled", {
			thresholds,
			queueCap: block.queueCap,
			evidence: block.evidence,
			system1: system1Block !== undefined,
		});
		// Staging from a killed run is garbage — clear before any review proposes.
		cleanupStaging(paths.workspace());
		runtime.setReviewer(
			new Reviewer({
				gate: system1Gate,
				thresholds,
				queueCap: block.queueCap,
				evidence: block.evidence,
				reviewModel: async (conversationId) => {
					const cfg = configRef.current;
					const conv = store.get(conversationId);
					if (!conv) throw new Error(`conversation ${conversationId} not found`);
					const ref = cfg.reviewer?.model ?? captureConversationSettings(store, conv, cfg).model;
					return {
						ref,
						model: observedModel(await resolveModel(cfg, auth, ref), {
							conversation: conversationId,
							purpose: "review",
						}),
					};
				},
				store,
				skillsDir: paths.skills(),
				proposedDir: paths.skillsProposed(),
				workspaceDir: paths.workspace(),
				notify: (conversationId, skills) =>
					sendSkillProposedNotice(tg.bot.api, conversationId, skills),
			}),
		);
	}

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

	// Recover inbox rows before polling: the wirings above must exist before
	// recovered turns run, and the offset must not advance past journaled input.
	await tg.replayInbox();
	tg.startPolling();

	// Search/transcription flips redraw the registered tool set — a cache
	// boundary (DESIGN.md → Web access) — so each flip gets its own log line.
	let searchInSet = config.search !== undefined;
	let transcribeInSet = config.transcription !== undefined;
	// App auth mode resolves once at boot: appToken set → bearer, unset →
	// trust (the tailnet is the lock); a mid-run flip needs a restart.
	const appTokenName = resolveAppAuth(config.appToken);
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
		// Memory is a boot-time snapshot (queue rows bind to the endpoint+bank hash).
		if (
			JSON.stringify(configRef.current.memory ?? null) !== JSON.stringify(memoryBootConfig ?? null)
		) {
			log.warn("memory config changed — restart to apply");
		}
		if (configRef.current.appToken !== appTokenName) {
			log.warn("appToken changed — restart to apply");
		}
		if (configRef.current.telegram.apiRoot !== apiRootBoot) {
			log.warn("telegram.apiRoot changed — restart to apply");
		}
		// The delegation block is boot-frozen (adapters + definitions are
		// one snapshot) — changes need a restart.
		if (
			JSON.stringify(configRef.current.delegation ?? null) !==
			JSON.stringify(delegationBoot ?? null)
		) {
			log.warn("delegation config changed — restart to apply");
		}
		// Same boot-freeze as delegation: models, pool limits and auth
		// refs are one snapshot the owner built at boot.
		if (
			JSON.stringify(configRef.current.subagents ?? null) !== JSON.stringify(subagentsBoot ?? null)
		) {
			log.warn("subagents config changed — restart to apply");
		}
	};
	// The same boot-pin comparisons onConfigWritten logs — the operator
	// surface's status card answers with them instead of waiting for the
	// operator to notice a warn line.
	const restartHints = (): string[] => {
		const cur = configRef.current;
		const hints: string[] = [];
		if (JSON.stringify(cur.memory ?? null) !== JSON.stringify(memoryBootConfig ?? null)) {
			hints.push("memory");
		}
		if (cur.appToken !== appTokenName) hints.push("appToken");
		if (cur.telegram.apiRoot !== apiRootBoot) hints.push("telegram.apiRoot");
		if (JSON.stringify(cur.delegation ?? null) !== JSON.stringify(delegationBoot ?? null)) {
			hints.push("delegation");
		}
		if (JSON.stringify(cur.subagents ?? null) !== JSON.stringify(subagentsBoot ?? null)) {
			hints.push("subagents");
		}
		return hints;
	};
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
						{ configRef, auth },
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
