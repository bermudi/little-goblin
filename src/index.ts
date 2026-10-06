// Composition root: config → auth → conversations → bot → http.

import { loadAuth } from "./auth.ts";
import { contextLimit, ensureOpenRouterCatalog, inputModalities, inputModalitiesCached } from "./agent/models-dev.ts";
import { systemPromptFor } from "./agent/prompt.ts";
import { observedModel, carriesMedia, resolveModel, thinkingOptions } from "./agent/providers.ts";
import type { MediaPosition } from "./agent/attachments.ts";
import { generateTopicTitle } from "./agent/title.ts";
import { generateText } from "ai";
import { homedir } from "node:os";
import { probeFfmpeg, transcribeAudio, transcriptionModel } from "./agent/transcribe.ts";
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
import { channelOf, openStore, type Conversation } from "./conversation.ts";
import { openDelegations } from "./delegations.ts";
import {
	startDelegationLifecycle,
	type DelegationLifecycle,
} from "./delegation-lifecycle.ts";
import type { DelegationPin } from "./agent/tools/delegate.ts";
import { makeHerdr } from "./herdr.ts";
import { makeSender, type MailPoller, type MailSender } from "./mail.ts";
import { makeGwsReader } from "./mail-gws.ts";
import { openOutbox } from "./mail-outbox.ts";
import { startMailWatcher } from "./mail-watcher.ts";
import { openPrograms } from "./programs.ts";
import { buildMemoryClient, startMemoryWorker, type MemoryWorker } from "./memory.ts";
import { JevClient } from "./jev.ts";
import { cleanupStaging } from "./reviewer.ts";
import { OutageTracker } from "./memory-outage.ts";
import { fireMail, fireWebhook, startScheduler, type SchedulerDeps } from "./scheduler.ts";
import { startHttp } from "./http/mod.ts";
import { handleAppApi, resolveAppAuth } from "./http/app-channel.ts";
import { isRollingChat } from "./rolling.ts";
import { discardSpinOff, spinOff } from "./spinoff.ts";
import { wake, wakeApp } from "./wake.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { applyMenuButton, AUTH_TELEGRAM_TOKEN, startBot } from "./tg/mod.ts";
import { makeBellSink } from "./tg/bell.ts";
import { sendMailNotice, startMailApproval } from "./tg/mail-approval.ts";
import { sendMemoryBlockedNotice, sendMemoryOutageNotice, sendSkillSavedNotice } from "./tg/notify.ts";
import { openPings } from "./tg/pings.ts";

// The file sink attaches before anything that can fail — a malformed
// config, bad auth file, corrupt DB, or occupied port must land in
// goblin.log, not die to stderr against an empty log. Late async
// failures ride the rejection handler for the same reason.
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

	// Shared ref: the mini app writes goblin.json5 and swaps this in place;
	// everything reads .current at point of use.
	const configRef: ConfigRef = { current: config, ttsDown: false };
	const auth = loadAuth();
	const store = openStore(paths.db());
	// Programs live in the same SQLite file (own connection) — standing
	// orders, DESIGN.md "Programs".
	const programs = openPrograms(paths.db());
	// Rolling DM cutover (design/telegram.md → Rolling DM): DM-topic
	// program pins re-pin to the bare chat — idempotent, one log line
	// per program.
	programs.rePinDmTopics();
	// The mail outbox opens unconditionally — drafts stay readable (and
	// cancellable) even when the mail block is removed; only the Gmail
	// clients gate on it.
	const outbox = openOutbox(paths.db());
	// Split authority, live closures: the gws-backed poller serves the
	// watcher, the send client serves only the approval taps and mints
	// its token in-process per call (mail.ts). No Gmail OAuth secret is
	// held here — gws owns its own auth (`gws auth login`).
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
	// Delegation is a boot-time snapshot like memory: the store and the
	// herdr adapter only exist when the block was configured at boot —
	// the herdr session is systemd's, not ours (DESIGN.md, Delegation).
	const delegationBoot = config.delegation;
	const delegations = delegationBoot ? openDelegations(paths.db()) : null;
	// "goblin" is not config: deploy/goblin-herdr.service's --session is
	// the single source of truth for the session name — no knob to drift
	// from the unit (DESIGN.md, Delegation).
	const herdr = delegationBoot ? makeHerdr("goblin") : null;

	// The delegation lifecycle — the protocol's one owner (DESIGN.md,
	// "Delegation") — is constructed after tg because its notices wake
	// through bot.api. The tool resolves it per turn through this
	// binding: no turn can run before the assignment below (turns start
	// from intake/scheduler/webhook wakes, and the first await after
	// startBot sits inside startHttp — the assignment happens before
	// it), so a null read there is a wiring bug, not a runtime state.
	let delegationLifecycle: DelegationLifecycle | null = null;
	const delegateDeps = (conv: Conversation) => {
		if (configRef.current.delegation === undefined || delegations === null || herdr === null) {
			return undefined;
		}
		if (delegationLifecycle === null) throw new Error("delegation lifecycle not wired");
		return {
			lifecycle: delegationLifecycle,
			config: configRef.current.delegation,
			workspaceDir: paths.workspace(),
			// Where a launch pins its notices — decided by the source
			// conversation's kind. App conversations DO get the tool
			// since the spin-off: an app-pinned row wakes its own
			// background turns and the bell rings Telegram — the "results
			// wake a Telegram sink the channel lacks" reason is what
			// background turns answered (design/app.md → Spin-off).
			// program and mail stay Telegram-only (disjoint pools).
			pin: (name: string): DelegationPin => {
				// App-native: the conversation IS the durable home — pin it
				// to itself, no fork.
				if (channelOf(conv.id) === "app") {
					return { address: { chatId: 0, threadId: null }, appConversation: conv.id };
				}
				// Rolling DM: fork the model view into a named app
				// conversation — a copy, never a move; the DM stays the
				// quick lane. discard undoes the fork when the launch
				// doesn't start (cap reached, failed).
				if (/^dm:\d+:\d+$/.test(conv.id) && isRollingChat(conv.chatId)) {
					const spun = spinOff(
						{
							store,
							titleFor,
							publicUrl: () => configRef.current.publicUrl || undefined,
						},
						conv,
						name,
					);
					// The fork's high-water mark at copy time — discard
					// deletes only while nothing newer landed, so input
					// the operator wrote into the visible fork survives.
					const seqAtFork = store.lastSeq(spun.conv.id);
					return {
						address: { chatId: 0, threadId: null },
						appConversation: spun.conv.id,
						movedToApp: { title: name, link: spun.link },
						discard: (reason) => discardSpinOff(store, spun.conv.id, seqAtFork, reason ?? "unspecified"),
					};
				}
				// Group topics and legacy bare DMs pin their Telegram
				// address like always.
				return { address: { chatId: conv.chatId, threadId: conv.threadId } };
			},
		};
	};

	// ffmpeg powers TTS remuxing and over-cap transcription — probe it
	// once at boot so a missing binary surfaces before the first speech
	// request. TTS is default-on and ffmpeg is its only dependency, so a
	// failed probe takes TTS down for the run (warn + /voice and the
	// speak tool report it) instead of failing message by message —
	// install ffmpeg and restart to re-enable. Transcription only needs
	// ffmpeg over the provider upload cap; the probe's warn covers that.
	if (config.transcription || config.tts) {
		const ok = await probeFfmpeg(config.tts ? "tts" : "transcription");
		if (!ok && config.tts) {
			configRef.ttsDown = true;
			log.warn(
				"tts disabled — ffmpeg not found on PATH; install ffmpeg and restart to enable voice replies",
			);
		}
	}

	// Warm the openrouter route-capability catalog so turn-time thinking
	// options and the mini app see real per-model thinking levels instead
	// of the cold-start fallback.
	void ensureOpenRouterCatalog();

	// Long-term memory is a boot-time snapshot: the queue binds rows to
	// the endpoint+bank hash, so mini-app memory edits apply on restart —
	// a config change can never redirect queued personal content mid-run.
	const memoryBootConfig = config.memory;
	const memoryClient = buildMemoryClient(memoryBootConfig ?? undefined, auth);
	const memoryState = { lastRecallOk: null as boolean | null, lastRecallAt: null as string | null };
	// Runtime recall telemetry for /memory status: the latest outcome and
	// when it happened. One closure serves both recall paths (pre-turn
	// recall and the memory_search tool).
	const noteRecall = (ok: boolean): void => {
		memoryState.lastRecallOk = ok;
		memoryState.lastRecallAt = new Date().toISOString();
	};
	if (memoryClient && memoryBootConfig) {
		log.info("memory enabled", {
			baseUrl: memoryBootConfig.baseUrl,
			bank: memoryBootConfig.bankId,
		});
	}

	// Speech → text, one seam shared by intake (voice/video notes) and
	// the transcribe tool (everything else, on demand). Read per call —
	// a mini-app save applies to the next voice note, no restart.
	const transcribeFile = async (file: Parameters<typeof transcribeAudio>[1]) => {
		const cfg = configRef.current.transcription;
		if (!cfg) return null;
		return transcribeAudio(await transcriptionModel(cfg, auth), file);
	};

	// The vision tool's per-turn gate (design/tools.md → Vision). mode
	// "auto" (default) registers it only while the chat model can't
	// consume images itself — the same two gates attachment
	// materialization applies: catalog modality AND the provider pipe.
	// A cold catalog counts as blind — a spare tool beats a blind agent.
	// mode "always" keeps it for vision-capable models too: a file on
	// disk is invisible regardless (tool results carry no image bytes).
	const visionDepsFor = (convId: string): VisionToolDeps | undefined => {
		const cfg = configRef.current;
		if (!cfg.vision) return undefined;
		if (cfg.vision.mode !== "always") {
			const { provider, modelId } = splitModelRef(cfg.model);
			const mods = inputModalitiesCached(provider, modelId);
			const kind = cfg.providers[provider]?.kind ?? "";
			if (mods !== null && mods.has("image") && carriesMedia(kind, "image/jpeg", "user")) {
				return undefined;
			}
		}
		return { configRef, auth, conversation: convId };
	};

	const runtime = new Runtime({
		store,
		async buildStep(conv, tools) {
			const cfg = configRef.current;
			// Model and thinking are config-only since /model and /think
			// retired (DESIGN.md, Commands) — stale per-topic overrides in
			// the db must never beat the mini app's defaults.
			const modelRef = cfg.model;
			const { provider, modelId } = splitModelRef(modelRef);
			// All may be slow (auth "!command", models.dev fetch) — run in
			// parallel inside the same admission window.
			const [model, modalities, contextWindow] = await Promise.all([
				resolveModel(cfg, auth, modelRef),
				inputModalities(provider, modelId),
				contextLimit(provider, modelId),
			]);
			// The pipe gate: what the provider's SDK converter can actually
			// deliver (carriesMedia, providers.ts). Catalog truth alone once
			// cost a thrown turn — openai-compatible < v3 rejected any
			// non-image file part the catalog said the model could take.
			const kind = cfg.providers[provider]?.kind;
			const carries = (mediaType: string, position: MediaPosition): boolean =>
				carriesMedia(kind ?? "", mediaType, position);
			const level: ThinkingLevel = cfg.thinking;
			const providerOptions = thinkingOptions(cfg, modelRef, level);
			const prompt = systemPromptFor(
				store,
				conv,
				// The registered set already reflects TTS and sink availability.
				toolNames(tools),
			);
			log.info("model step", {
				conversation: conv.id,
				model: modelRef,
				thinking: level,
				prompt: prompt.sources.join("+"),
			});
			return {
				// Observed at the model boundary: every call this turn makes —
				// tool-loop continuations included — logs its request hashes.
				model: observedModel(model, { conversation: conv.id }),
				system: prompt.text,
				label: modelRef,
				inputModalities: modalities,
				carries,
				...(contextWindow !== null ? { contextWindow } : {}),
				...(providerOptions ? { providerOptions } : {}),
			};
		},
		// Compaction wiring (DESIGN.md, Compaction): the conversation's own
		// model writes the summary — same resolution path as turns (auth,
		// relays), plain generate, no tools, default thinking.
		compaction: {
			modelRef: () => configRef.current.model,
			summarize: async (conv, system, prompt, signal) => {
				const cfg = configRef.current;
				const modelRef = cfg.model;
				const model = observedModel(await resolveModel(cfg, auth, modelRef), {
					conversation: conv.id,
					purpose: "compaction",
				});
				const { text } = await generateText({ model, instructions: system, prompt, abortSignal: signal });
				return text;
			},
		},
		makeTools: (conv, deliverVoice, recording, deliverFile, accepts) => {
			const tts = configRef.current.tts;
			// Telegram-bound tools don't exist on the app channel: program
			// hooks wake Telegram sinks and mail drafts post Telegram
			// approval buttons. Their dep slots go undefined, so the tools
			// never register on an app turn (DESIGN.md, App channel —
			// disjoint pools). delegate is the exception — it registers
			// everywhere since the spin-off: an app turn's launches pin
			// the conversation itself (design/app.md → Spin-off).
			const telegram = channelOf(conv.id) === "telegram";
			return makeTools(
				paths.workspace(),
				tts && !configRef.ttsDown && deliverVoice
					? {
							// A per-call voice replaces the whole config voice — Edge
							// derives the language from the voice name, so an
							// alternate voice is an alternate language. An explicit
							// pick wins outright: with no alternates to sniff
							// against, pickVoice can't override it.
							synthesize: (text, voice) =>
								synthesizeSpeech(text, voice ? { ...tts, voice, voices: [] } : tts),
							deliver: deliverVoice,
							...(recording ? { recording } : {}),
							// The allowlist always carries the default: picking it
							// explicitly is a no-op.
							...(tts.voices?.length
								? { voices: [...new Set([tts.voice, ...tts.voices])] }
								: {}),
						}
					: undefined,
				// The program tool pins new programs to the conversation it runs
				// in. Hook URLs go through sendPrivate — a DM to each operator
				// (a group topic's readers aren't implicitly authorized), and a
				// bare api.sendMessage never lands in history, so the token
				// stays out of model context. publicUrl reads live: the mini app
				// can change it between turns.
				telegram
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
				// The send_file tool hands workspace paths to the turn's
				// delivery sink, which owns the Telegram send.
				deliverFile ? { deliver: deliverFile } : undefined,
				// Memory search recalls the shared bank; excluded topics
				// recall nothing by any path.
				memoryClient && memoryBootConfig
					? {
							client: memoryClient,
							maxTokens: memoryBootConfig.maxTokens,
							budget: memoryBootConfig.budget,
							isExcluded: () => conv.memoryExcluded,
							noteRecall,
						}
					: undefined,
				// Web tools: fetch always (local needs no config), search
				// behind its config block — both read configRef live. The
				// accepts ref rides along for the fetch tool's per-turn PDF
				// rendering.
				{ configRef, auth, ...(accepts ? { accepts } : {}) },
				// The transcribe tool joins/leaves the set with the
				// transcription block — same live-read rule as search.
				configRef.current.transcription !== undefined
					? { transcribe: transcribeFile }
					: undefined,
				// The delegate tool rides the live config like search —
				// but the store/adapter are boot fixtures, so removing
				// the block hides the tool next turn while the lifecycle
				// keeps tracking rows it already owns.
				delegateDeps(conv),
				// The mail tool rides the same live gate — and holds only
				// the approval gate's request closure: the send
				// credential is nowhere in this dep tree (the approval
				// taps hold it instead), and the draft's address is
				// pinned here, per conversation. Reads left for the
				// goblin-mail wrapper (bash + gws skill).
				telegram && configRef.current.mail !== undefined
					? {
							requestDraft: (input) =>
								mailApproval.requestDraft(input, {
									chatId: conv.chatId,
									threadId: conv.threadId,
								}),
						}
					: undefined,
				// Past-chat search rides the store — always present, local
				// state, no config block. Excluded topics recall nothing.
				{ store, isExcluded: () => conv.memoryExcluded },
				// Image Q&A joins the set per the vision block's mode —
				// same live-read rule as transcribe/search. Threads are
				// process-global; a model change inside the block drops
				// them on the next call (src/agent/vision.ts).
				visionDepsFor(conv.id),
			);
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

	// /forget delete quiesces the retention worker through this holder: the
	// worker is created below, after the bot (its notices deliver through
	// bot.api), but the bot's memory deps close over the quiesce seam at
	// construction — a submit in flight while the delete cancels its row
	// re-creates the document remotely (see MemoryWorker.withWorkerPaused).
	// Nothing between startBot resolving and the assignment is async, so no
	// update can be handled with the holder still empty; the throw is a
	// wiring-bug alarm, not a runtime state.
	const retentionQuiesce: { worker: MemoryWorker | null } = { worker: null };
	// One titler for both channels: telegram implicit topics and the app
	// channel's first-turn naming (app-channel.ts) share the titleModel.
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
		...(memoryClient
			? {
					memory: {
						client: memoryClient,
						contexts: store.memoryContexts,
						queue: store.memoryQueue,
						withWorkerPaused: <T>(fn: () => Promise<T>): Promise<T> => {
							const worker = retentionQuiesce.worker;
							if (worker === null) throw new Error("retention worker not wired");
							return worker.withWorkerPaused(fn);
						},
						lastRecallOk: () => memoryState.lastRecallOk,
						lastRecallAt: () => memoryState.lastRecallAt,
					},
				}
			: {}),
		// Draft approvals always wire up — the outbox outlives the mail
		// block, and the taps degrade to toasts without it. The gate
		// itself is constructed right below (it needs bot.api), so taps
		// resolve it per-tap through this getter.
		mail: () => mailApproval,
		// The Rolling DM follow-up check rides the reviewer's JevClient —
		// also built after the bot, so the roller resolves it per call
		// through this getter. Absent = no check, bursts join current.
		followUpGate: () => jevGate ?? undefined,
	});

	// The mail approval gate — the draft's one owner: the tool's send
	// request lands here (queue → post → bind), the Send/Cancel taps
	// decide here, and the expiry sweep runs here on its own ticker.
	// Always started — orphaned drafts still settle without a mail
	// block.
	const mailApproval = startMailApproval({
		api: tg.bot.api,
		outbox,
		sender: mailSender,
		reader: mailPoller,
	});

	// Memory worker after the bot: a persistent outage notices the
	// operator through bot.api (one message per episode, into the topic
	// whose retention is stuck — DESIGN.md, Slice 2 ruling 5 amendment),
	// and a blocked retention does the same once per document (retry
	// requeues with fresh operation ids — MemoryQueue.retryBlocked).
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
	if (memoryWorker !== null) retentionQuiesce.worker = memoryWorker;

	// Skill reviewer after the bot: its save note delivers through
	// bot.api, so the runtime can't hold it before tg exists. Absent
	// block = the feature is off. The block is hand-edited-only (no
	// mini-app surface), so gate auth and threshold are boot-captured
	// (system1's auth/model/baseUrl ride the same capture — a hand-edit
	// applies on restart); the review model resolves live per review —
	// the mini app owns the default between reviews.
	// The reviewer's JevClient doubles as the loopback injection-check
	// gate below — one instance, its auth closure resolves per call.
	const reviewerBlock = configRef.current.reviewer;
	const jevGate = reviewerBlock
		? new JevClient({
				auth: () => auth.resolve(configRef.current.system1?.auth ?? reviewerBlock.auth),
				// System One is the Jev gate source when present; absent
				// pieces fall back to reviewer.auth / JevClient defaults
				// so the live reviewer never breaks. reviewerBlock stays
				// the on/off switch.
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
		log.info("reviewer enabled", { thresholds, queueCap: block.queueCap, evidence: block.evidence, system1: configRef.current.system1 !== undefined });
		// Staging from a killed run can only be garbage — clear it before
		// any review can publish alongside it.
		cleanupStaging(paths.workspace());
		runtime.setReviewer({
			gate: jevGate,
			thresholds,
			queueCap: block.queueCap,
			evidence: block.evidence,
			reviewModel: async (conversationId) => {
				const cfg = configRef.current;
				const ref = cfg.reviewer?.model ?? cfg.model;
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
			notify: (conversationId, skills) => sendSkillSavedNotice(tg.bot.api, conversationId, skills),
		});
	}

	// The shared wake path — program fires (cron, webhook, mail) submit
	// through it into the pinned conversation. The firing owner's deps:
	// the trigger entry points take this plus the programs store.
	// The ping→conversation map — shared with the bell below so a
	// swipe-reply to a spin-off ping routes into the app conversation
	// that rang (design/app.md → Spin-off). Intake opens its own handle
	// on the same db inside createBot.
	const pings = openPings(store.db);
	const wakeDeps = {
		store,
		runtime,
		api: tg.bot.api,
		configRef,
		synthesize: (text: string, tts: TtsConfig) => synthesizeSpeech(text, tts),
		// Rolling DM: fires into a private chat route through the roller
		// (past the gap they roll, inside it they join) — the gap reads
		// config live, the gate is the reviewer's JevClient above.
		roll: {
			store,
			runtime,
			gapMinutes: () => configRef.current.telegram.dmGapMinutes,
			gate: () => jevGate ?? undefined,
		},
		// The headless sink app-channel background turns submit with —
		// a delegation notice to an app conversation pings the
		// operator's DM with the deep link when the turn lands.
		bell: (conv: Conversation) =>
			makeBellSink(
				{
					api: tg.bot.api,
					store,
					pings,
					allowedUsers: () => configRef.current.allowedUsers,
					publicUrl: () => configRef.current.publicUrl || undefined,
				},
				conv,
				"delegation notice",
			),
	};
	const firingDeps: SchedulerDeps = {
		...wakeDeps,
		programs,
		// The reviewer's Jev gate doubles as the watcher-event
		// scorer (fail-open) — same instance the loopback checker
		// route holds. Absent reviewer block = events fire unscored.
		...(jevGate ? { checkMail: jevGate as Pick<typeof jevGate, "decide"> } : {}),
	};

	// The delegation lifecycle — the protocol's one owner: the tool's
	// launch/send/stop/read land here and the watcher's verdicts fire
	// here, on the scheduler's ticker pattern. This exact spot is
	// load-bearing: after tg (notices wake through bot.api) but before
	// the first await after startBot (inside startHttp below), so the
	// delegateDeps binding is filled before any update can start a turn.
	delegationLifecycle =
		delegations !== null && herdr !== null
			? startDelegationLifecycle({
					delegations,
					herdr,
					delegationsDir: paths.delegations(),
					// Harness trust files live under the real home —
					// delegation panes run the operator's shell there.
					homeDir: homedir(),
					// Delegation notices never roll the DM — a result
					// arriving past the gap still belongs to the live
					// conversation (Rolling DM).
					wake: (address, text) => wake(wakeDeps, address, text, { dmTrigger: "current" }),
					// An app-pinned row wakes its app conversation's
					// background turn — the bell rings the DM (Spin-off).
					wakeApp: (conversationId, text) => wakeApp(wakeDeps, conversationId, text),
				})
			: null;

	// Recover inbox rows before polling new updates. The delegation/tool
	// closures above must exist before recovered turns can run, and the
	// polling offset must not advance ahead of journaled input.
	await tg.replayInbox();
	tg.startPolling();

	// The search and transcription blocks' enable/disable redraw the
	// registered tool set — a cache boundary per DESIGN.md "Web access" —
	// so each flip gets its own line, not just the generic
	// config-written one.
	let searchInSet = config.search !== undefined;
	let transcribeInSet = config.transcription !== undefined;
	// The app channel's auth mode resolves once here at boot (DESIGN.md,
	// App channel → Auth): appToken set → bearer required; unset → trust
	// mode — the tailnet is the only lock. Boot-pinned per process, so a
	// mid-run flip applies only after restart — onConfigWritten warns.
	const appTokenName = resolveAppAuth(config.appToken);
	// One post-write path for every config door (mini app form, app
	// channel's model/thinking knobs): hot-apply what's live, warn on
	// what's boot-pinned.
	const onConfigWritten = () => {
		setLogLevel(configRef.current.logLevel);
		// publicUrl is operator-editable through the app — keep the menu
		// button (the door) in sync without a restart.
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
		// Memory is a boot-time snapshot (queue rows bind to the
		// endpoint+bank hash) — a changed block needs a restart.
		if (JSON.stringify(configRef.current.memory ?? null) !== JSON.stringify(memoryBootConfig ?? null)) {
			log.warn("memory config changed — restart to apply");
		}
		// The app channel's auth mode is boot-pinned like memory —
		// a flipped appToken applies only after restart.
		if (configRef.current.appToken !== appTokenName) {
			log.warn("appToken changed — restart to apply");
		}
	};
	const http = startHttp({
		configRef,
		botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
		// POST /hook/<token> — the token is the credential; the hit wakes
		// the program through the webhook entry point, which owns the
		// fire's accounting (last_run only when landed).
		hooks: {
			programs,
			accepting: () => runtime.accepting(),
			fire: (program, event, now) => fireWebhook(firingDeps, program, event, now),
		},
		// Same memory seams the /memory command reads, bound to the
		// boot-time target — the mini app's status card renders the same
		// truth the command does. Absent when memory is unconfigured.
		...(memoryClient
			? {
					memory: {
						...(memoryBootConfig ? { target: {
							baseUrl: memoryBootConfig.baseUrl, bankId: memoryBootConfig.bankId,
						} } : {}),
						counts: () => store.memoryQueue.counts(memoryClient.target),
						blockedDetail: () => store.memoryQueue.blockedDetail(memoryClient.target),
						lastRecallOk: () => memoryState.lastRecallOk,
						lastRecallAt: () => memoryState.lastRecallAt,
						// Memories browser: reads and forgetting ride the same
						// client and seams /forget delete uses — including the
						// retention-worker quiesce (holder read lazily; the worker
						// is assigned before the first request can arrive).
						client: memoryClient,
						contexts: store.memoryContexts,
						queue: store.memoryQueue,
						withWorkerPaused: <T>(fn: () => Promise<T>): Promise<T> => {
							const worker = retentionQuiesce.worker;
							if (worker === null) throw new Error("retention worker not wired");
							return worker.withWorkerPaused(fn);
						},
					},
				}
			: {}),
		// The reviewer's Jev gate doubles as the loopback injection
		// checker — same instance, no second auth closure. Absent
		// reviewer block = no gate = the route answers 503.
		...(jevGate ? { checkInjection: { gate: jevGate } } : {}),
		// The app channel's API — always wired; the auth mode resolved
		// above at boot (trust or bearer — no per-request config read).
		// The handler injects opaque (app-channel.ts imports the
		// runtime/AI-SDK graph, which must not enter http/mod.ts's
		// DOM-lib typecheck program).
		appApi: (req, url) =>
			handleAppApi(req, url, appTokenName, {
				store,
				runtime,
				auth,
				configRef,
				onConfigWritten,
				// Same intake seam the tg lane runs for voice notes —
				// speech:true uploads get their transcript before submit.
				transcribe: transcribeFile,
				// Read-aloud for replies. Null = unconfigured or ffmpeg-down;
				// the endpoint answers 503 rather than failing mid-synthesis.
				speak: async (text) => {
					const tts = configRef.current.tts;
					// "", false, or unset all mean speech is off; ttsDown is
					// the boot ffmpeg probe.
					if (!tts || configRef.ttsDown) return null;
					return synthesizeSpeech(text, tts);
				},
				titleFor,
			}),
		onConfigWritten,
	});

	// Scheduler after the bot: it submits into conversations and delivers
	// through bot.api — both must exist. The boot scan fires anything
	// missed while the process was down (DESIGN.md, Programs).
	const scheduler = startScheduler(firingDeps);

	// The mail watcher is the scheduler's twin: it polls Gmail through
	// gws for enabled mail filters and hands matches to the mail entry
	// point, which owns the checkpoint policy. Always started — without
	// the mail block it idles (draft expiry lives in the approval gate,
	// not here).
	const mailWatcher = startMailWatcher({
		programs,
		reader: mailPoller,
		fire: (program, hits, checkpoint, now) =>
			fireMail(firingDeps, program, hits, checkpoint, now),
		notify: (address, text) => sendMailNotice(tg.bot.api, address, text),
	});

	return { configRef, auth, store, programs, outbox, delegations, runtime, tg, http, scheduler, delegationLifecycle, mailWatcher, mailApproval, memoryWorker };
}

let booted: Awaited<ReturnType<typeof boot>>;
try {
	booted = await boot();
} catch (err) {
	log.error("boot failed", err);
	process.exit(1);
}
const { store, programs, outbox, delegations, runtime, tg, http, scheduler, delegationLifecycle, mailWatcher, mailApproval, memoryWorker } = booted;

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
	// Join any in-flight scan before closing the store. Runtime closes
	// below without waiting for it, so late notices remain retryable.
	// Running agents belong to herdr and resume on next boot.
	const delegationScan = delegationLifecycle?.stopTicker() ?? Promise.resolve();
	// The mail watcher only stops polling — cursors and drafts persist.
	mailWatcher.stop();
	// The approval gate stops sweeping AND joins an in-flight Gmail
	// send — a SIGTERM mid-send would otherwise kill the send before its
	// verdict landed, leaving the row pending and un-stamped (stale
	// information for a re-tap or the sweep's expiry stamp). Bounded by
	// the drain budget below.
	const mailSends = mailApproval.stop();
	// The retention worker only drains the outbox — stopping it leaves
	// pending rows durable for the next boot.
	await memoryWorker?.stop();
	// bot.stop confirms the polling offset so handled updates don't
	// redeliver on the next boot.
	const stopping = tg.bot.stop().catch((err: unknown) => {
		log.warn("bot stop failed", { error: String(err) });
	});
	// Close the runtime first — intake that lands during the drain still
	// reaches history but never starts a turn. Fencing each lane makes
	// its sink stamp "⏹ superseded" and run a final flush; drainIntake
	// lands coalescing-buffer messages in history the same way.
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
				log.warn("shutdown step failed", { error: String(r.reason) });
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
