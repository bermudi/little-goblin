// Composition root: config → auth → conversations → bot → http.

import { loadAuth } from "./auth.ts";
import { contextLimit, ensureOpenRouterCatalog, inputModalities } from "./agent/models-dev.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";
import { observedModel, resolveModel, thinkingOptions } from "./agent/providers.ts";
import { generateTopicTitle } from "./agent/title.ts";
import { generateText } from "ai";
import { probeFfmpeg, transcribeAudio, transcriptionModel } from "./agent/transcribe.ts";
import { synthesizeSpeech } from "./agent/tts.ts";
import { makeTools, toolNames } from "./agent/tools/mod.ts";
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
import { openStore } from "./conversation.ts";
import { openDelegations, startDelegationWatcher } from "./delegations.ts";
import { makeHerdr } from "./herdr.ts";
import { openPrograms } from "./programs.ts";
import { buildMemoryClient, startMemoryWorker } from "./memory.ts";
import { OutageTracker } from "./memory-outage.ts";
import { fireProgram, startScheduler } from "./scheduler.ts";
import { startHttp } from "./http/mod.ts";
import { wake } from "./wake.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { applyMenuButton, AUTH_TELEGRAM_TOKEN, startBot } from "./tg/mod.ts";
import { sendMemoryBlockedNotice, sendMemoryOutageNotice } from "./tg/notify.ts";

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
	// Delegation is a boot-time snapshot like memory: the store and the
	// herdr adapter only exist when the block was configured at boot —
	// the herdr session is systemd's, not ours (DESIGN.md, Delegation).
	const delegationBoot = config.delegation;
	const delegations = delegationBoot ? openDelegations(paths.db()) : null;
	const herdr = delegationBoot ? makeHerdr(delegationBoot.session) : null;

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
			const level: ThinkingLevel = cfg.thinking;
			const providerOptions = thinkingOptions(cfg, modelRef, level);
			const prompt = buildSystemPrompt(
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
				inputModalities: modalities,
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
				const { text } = await generateText({ model, system, prompt, abortSignal: signal });
				return text;
			},
		},
		makeTools: (conv, deliverVoice, recording, deliverFile) => {
			const tts = configRef.current.tts;
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
				{
					programs,
					chatId: conv.chatId,
					threadId: conv.threadId,
					publicUrl: () => configRef.current.publicUrl,
					sendPrivate: makePrivateSender(
						(id, text) => tg.bot.api.sendMessage(id, text),
						() => configRef.current.allowedUsers,
					),
				},
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
				// behind its config block — both read configRef live.
				{ configRef, auth },
				// The transcribe tool joins/leaves the set with the
				// transcription block — same live-read rule as search.
				configRef.current.transcription !== undefined
					? { transcribe: transcribeFile }
					: undefined,
				// The delegate tool rides the live config like search —
				// but the store/adapter are boot fixtures, so removing
				// the block hides the tool next turn while the watcher
				// keeps tracking rows it already owns.
				configRef.current.delegation !== undefined && delegations && herdr
					? {
							delegations,
							herdr,
							config: configRef.current.delegation,
							chatId: conv.chatId,
							threadId: conv.threadId,
							workspaceDir: paths.workspace(),
							delegationsDir: paths.delegations(),
						}
					: undefined,
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

	const tg = await startBot({
		configRef,
		auth,
		store,
		runtime,
		async titleFor(text) {
			const cfg = configRef.current;
			if (!cfg.titleModel) return null;
			const model = await resolveModel(cfg, auth, cfg.titleModel);
			return generateTopicTitle(
				observedModel(model, { purpose: "topic-title" }),
				text,
				thinkingOptions(cfg, cfg.titleModel, "off"),
			);
		},
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
						lastRecallOk: () => memoryState.lastRecallOk,
						lastRecallAt: () => memoryState.lastRecallAt,
					},
				}
			: {}),
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

	// The shared wake path — program fires (cron or webhook) submit
	// through it into the pinned conversation.
	const wakeDeps = {
		store,
		runtime,
		api: tg.bot.api,
		configRef,
		synthesize: (text: string, tts: TtsConfig) => synthesizeSpeech(text, tts),
	};

	// The search and transcription blocks' enable/disable redraw the
	// registered tool set — a cache boundary per DESIGN.md "Web access" —
	// so each flip gets its own line, not just the generic
	// config-written one.
	let searchInSet = config.search !== undefined;
	let transcribeInSet = config.transcription !== undefined;
	const http = startHttp({
		configRef,
		botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
		// POST /hook/<token> — the token is the credential; the hit wakes
		// the program through the same fire path as a cron tick.
		hooks: {
			programs,
			accepting: () => runtime.accepting(),
			fire: (program, trigger, event, now) =>
				fireProgram(wakeDeps, program, trigger, event, now),
		},
		// Same memory seams the /memory command reads, bound to the
		// boot-time target — the mini app's status card renders the same
		// truth the command does. Absent when memory is unconfigured.
		...(memoryClient
			? {
					memory: {
						counts: () => store.memoryQueue.counts(memoryClient.target),
						blockedDetail: () => store.memoryQueue.blockedDetail(memoryClient.target),
						lastRecallOk: () => memoryState.lastRecallOk,
						lastRecallAt: () => memoryState.lastRecallAt,
					},
				}
			: {}),
		onConfigWritten: () => {
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
		},
	});

	// Scheduler after the bot: it submits into conversations and delivers
	// through bot.api — both must exist. The boot scan fires anything
	// missed while the process was down (DESIGN.md, Programs).
	const scheduler = startScheduler({
		programs,
		...wakeDeps,
	});

	// The delegation watcher is the scheduler's twin: it polls herdr
	// for active rows and reports transitions as turns through the same
	// wake path. Needs bot.api — starts after tg for the same reason.
	const delegationWatcher =
		delegations && herdr
			? startDelegationWatcher({
					delegations,
					herdr,
					delegationsDir: paths.delegations(),
					wake: (address, text) => wake(wakeDeps, address, text),
				})
			: null;

	return { configRef, auth, store, programs, delegations, runtime, tg, http, scheduler, delegationWatcher, memoryWorker };
}

let booted: Awaited<ReturnType<typeof boot>>;
try {
	booted = await boot();
} catch (err) {
	log.error("boot failed", err);
	process.exit(1);
}
const { store, programs, delegations, runtime, tg, http, scheduler, delegationWatcher, memoryWorker } = booted;

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
	// The watcher only stops polling — running agents belong to the
	// herdr unit, not this process; rows resume on next boot.
	delegationWatcher?.stop();
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
	const settled = Promise.allSettled([stopping, drained, flushed]);
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
