// Composition root — it wires, it never rules (DESIGN.md → Module map).

import { loadAuth } from "./auth.ts";
import {
	contextLimit,
	ensureOpenRouterCatalog,
	inputModalities,
	inputModalitiesCached,
} from "./agent/models-dev.ts";
import { systemPromptFor } from "./agent/prompt.ts";
import { observedModel, carriesMedia, resolveModel, thinkingOptions } from "./agent/providers.ts";
import type { MediaPosition } from "./agent/attachments.ts";
import { generateTopicTitle } from "./agent/title.ts";
import { generateText } from "ai";
import { homedir } from "node:os";
import { probeFfmpeg, speechEngine, transcribeAudio } from "./agent/transcribe.ts";
import { whistleArtifactPresence } from "./agent/transcribe-whistle.ts";
import { synthesizeSpeech } from "./agent/tts.ts";
import { makeTools, toolNames, type VisionToolDeps } from "./agent/tools/mod.ts";
import { makePrivateSender } from "./agent/tools/program.ts";
import {
	ensureHomeLayout,
	goblinHome,
	loadConfig,
	paths,
	splitModelRef,
	type ConfigRef,
	type ThinkingLevel,
	type TtsConfig,
} from "./config.ts";
import {
	captureConversationSettings,
	channelOf,
	openStore,
	prepareAppSettingsForConfig,
	type Conversation,
} from "./conversation.ts";
import { openDelegations } from "./delegations.ts";
import {
	delegationWake,
	startDelegationLifecycle,
	type DelegationLifecycle,
	type DelegationTargetDeps,
} from "./delegation-lifecycle.ts";
import { makeHerdr } from "./herdr.ts";
import { makeSender, type MailPoller, type MailSender } from "./mail.ts";
import { makeGwsReader } from "./mail-gws.ts";
import { openOutbox } from "./mail-outbox.ts";
import { startMailWatcher } from "./mail-watcher.ts";
import { openPrograms } from "./programs.ts";
import {
	buildDestinationClient,
	buildMemoryClient,
	startMemoryWorker,
	type MemoryWorker,
} from "./memory.ts";
import { JevClient } from "./jev.ts";
import { cleanupStaging, Reviewer } from "./reviewer.ts";
import { OutageTracker } from "./memory-outage.ts";
import { fireMail, fireWebhook, startScheduler, type SchedulerDeps } from "./scheduler.ts";
import { startHttp } from "./http/mod.ts";
import { handleAppApi, resolveAppAuth } from "./http/app-channel.ts";
import { launchPin, type SpinOffDeps } from "./spinoff.ts";
import { makeWakeDeps } from "./wake.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { applyMenuButton, AUTH_TELEGRAM_TOKEN, startBot } from "./tg/mod.ts";
import { sendMailNotice, startMailApproval } from "./tg/mail-approval.ts";
import { filterGuestTools } from "./tg/guest.ts";
import {
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendSkillSavedNotice,
} from "./tg/notify.ts";
import { openPings } from "./tg/pings.ts";

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

async function boot() {
	ensureHomeLayout();

	const config = loadConfig();
	if (!config) {
		log.error(`no config at ${paths.config()} — copy goblin.json5.example and fill it in`);
		process.exit(1);
	}
	setLogLevel(config.logLevel);

	// Shared ref: the mini app swaps this in place on save; everything
	// reads .current at point of use.
	const configRef: ConfigRef = { current: config, ttsDown: false };
	const auth = loadAuth();
	const store = openStore(paths.db());
	for (const conv of store.listAppConversations()) store.initializeAppSettings(conv.id, config);
	const programs = openPrograms(paths.db());
	programs.rePinDmTopics();
	// The outbox opens unconditionally — drafts stay readable and
	// cancellable without the mail block; only the clients gate on it.
	const outbox = openOutbox(paths.db());
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
	// NULL-target live rows predate the machines era (the own local
	// session) — warn, never guess.
	if (delegations !== null) {
		const nullLive = delegations.liveRowsWithNullTarget();
		if (nullLive > 0) {
			log.warn("live delegation rows predate targets and are assumed local", { count: nullLive });
		}
	}
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
	const delegateDeps = (conv: Conversation) => {
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
			workspaceDir: paths.workspace(),
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
		const ok = await probeFfmpeg(feature);
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
			const prompt = systemPromptFor(store, conv, toolNames(tools));
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
			const tools = makeTools({
				cwd: paths.workspace(),
				voice:
					tts && !configRef.ttsDown && deliverVoice
						? {
								// A per-call voice replaces the config voice outright — Edge
								// derives the language from the voice name; the allowlist
								// always carries the default.
								synthesize: (text, voice) =>
									synthesizeSpeech(text, voice ? { ...tts, voice, voices: [] } : tts),
								deliver: deliverVoice,
								...(recording ? { recording } : {}),
								...(tts.voices?.length ? { voices: [...new Set([tts.voice, ...tts.voices])] } : {}),
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
								(id, text) => tg.bot.api.sendMessage(id, text),
								() => configRef.current.allowedUsers,
							),
						}
					: undefined,
				file: deliverFile ? { deliver: deliverFile } : undefined,
				memory:
					memoryClient && memoryBootConfig
						? {
								client: memoryClient,
								maxTokens: memoryBootConfig.maxTokens,
								budget: memoryBootConfig.budget,
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
				delegate: delegateDeps(conv),
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
				history: { store, isExcluded: () => conv.memoryExcluded },
				// Threads are process-global; a model change drops them on the next call.
				vision: visionDepsFor(conv),
			});
			// Guest mode: hard toolset exclusion after assembly (design/telegram.md → Guest mode).
			return filterGuestTools(conv, tools);
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
			return synthesizeSpeech(text, tts);
		},
		transcribe: transcribeFile,
		...(memorySurfaces ? { memory: { ...memorySurfaces } } : {}),
		mail: () => mailApproval,
		followUpGate: () => jevGate ?? undefined,
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
	const jevGate = reviewerBlock
		? new JevClient({
				auth: () => auth.resolve(configRef.current.system1?.auth ?? reviewerBlock.auth),
				// System One is the gate source when present; absent falls back to defaults.
				...(configRef.current.system1?.model !== undefined
					? { model: configRef.current.system1.model }
					: {}),
				...(configRef.current.system1?.baseUrl !== undefined
					? { baseUrl: configRef.current.system1.baseUrl }
					: {}),
			})
		: null;
	if (jevGate !== null) {
		const block = reviewerBlock; // narrowed: non-null exactly when the gate exists
		if (!block) throw new Error("reviewer gate without block");
		const thresholds = {
			correction: block.thresholds?.correction ?? block.threshold,
			procedure: block.thresholds?.procedure ?? block.threshold,
		};
		log.info("reviewer enabled", {
			thresholds,
			queueCap: block.queueCap,
			evidence: block.evidence,
			system1: configRef.current.system1 !== undefined,
		});
		// Staging from a killed run is garbage — clear before any review publishes.
		cleanupStaging(paths.workspace());
		runtime.setReviewer(
			new Reviewer({
				gate: jevGate,
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
				workspaceDir: paths.workspace(),
				notify: (conversationId, skills) =>
					sendSkillSavedNotice(tg.bot.api, conversationId, skills),
			}),
		);
		// The loop watchdog rides the same JevClient (design/model.md → "No step
		// budget"): every 16 completed calls system1 scores the digest ring — warn
		// once, cut on the second stuck verdict.
		runtime.setLoopWatchdog({ decide: jevGate.decide.bind(jevGate) });
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
		synthesize: (text: string, tts: TtsConfig) => synthesizeSpeech(text, tts),
		followUpGate: () => jevGate ?? undefined,
		pings,
	});
	const firingDeps: SchedulerDeps = {
		...wakeDeps,
		programs,
		// The Jev gate doubles as the watcher-event scorer (fail-open) — unscored absent.
		...(jevGate ? { checkMail: jevGate as Pick<typeof jevGate, "decide"> } : {}),
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
		// The delegation block is boot-frozen (adapters + definitions are
		// one snapshot) — changes need a restart.
		if (
			JSON.stringify(configRef.current.delegation ?? null) !==
			JSON.stringify(delegationBoot ?? null)
		) {
			log.warn("delegation config changed — restart to apply");
		}
	};
	const http = startHttp({
		configRef,
		beforeConfigWritten: (previous, next) => prepareAppSettingsForConfig(store, previous, next),
		botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
		// POST /hook/<token> — the token is the credential; the webhook
		// entry point owns the fire's accounting (last_run only when landed).
		hooks: {
			programs,
			accepting: () => runtime.accepting(),
			fire: (program, event, now) => fireWebhook(firingDeps, program, event, now),
		},
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
		// The Jev gate doubles as the loopback injection checker — absent = 503.
		...(jevGate ? { checkInjection: { gate: jevGate } } : {}),
		// The app handler stays opaque here: app-channel.ts imports the
		// runtime/AI-SDK graph, which must not enter http/mod.ts's DOM-lib
		// typecheck program.
		appApi: (req, url) =>
			handleAppApi(req, url, appTokenName, {
				store,
				runtime,
				auth,
				configRef,
				onConfigWritten,
				// Same intake seam as the tg lane — speech uploads transcribe before submit.
				transcribe: transcribeFile,
				// Null = unconfigured or ffmpeg-down — the endpoint answers 503
				// rather than failing mid-synthesis.
				speak: async (text) => {
					const tts = configRef.current.tts;
					if (!tts || configRef.ttsDown) return null;
					return synthesizeSpeech(text, tts);
				},
				titleFor,
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
} = booted;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Long enough for the sinks' final flushes and polling's offset
// confirm; short enough that a wedged Telegram API can't hold a deploy.
const SHUTDOWN_DRAIN_MS = 10_000;
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
	// The mail watcher only stops polling — cursors and drafts persist.
	mailWatcher.stop();
	// The approval gate stops sweeping AND joins an in-flight Gmail send
	// bounded by the drain budget below.
	const mailSends = mailApproval.stop();
	// The retention worker only drains the outbox — pending rows stay
	// durable for the next boot.
	await memoryWorker?.stop();
	// bot.stop confirms the polling offset so handled updates don't
	// redeliver on the next boot.
	const stopping = tg.bot.stop().catch((err: unknown) => {
		log.warn("bot stop failed", err);
	});
	// Close the runtime first — intake that lands during the drain still
	// reaches history but never starts a turn.
	const drained = runtime.shutdown();
	const flushed = tg.drainIntake();
	const settled = Promise.allSettled([stopping, drained, flushed, delegationScan, mailSends]);
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

log.info("goblin up", { home: goblinHome() });
