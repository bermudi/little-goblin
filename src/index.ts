// Composition root: config → auth → conversations → bot → http.

import { loadAuth } from "./auth.ts";
import { contextLimit, ensureOpenRouterCatalog, inputModalities } from "./agent/models-dev.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";
import { observedModel, resolveModel, thinkingOptions } from "./agent/providers.ts";
import { generateTopicTitle } from "./agent/title.ts";
import { checkFfmpeg, transcribeAudio, transcriptionModel } from "./agent/transcribe.ts";
import { synthesizeSpeech } from "./agent/tts.ts";
import { makeTools, toolNames } from "./agent/tools/mod.ts";
import {
	ensureHomeLayout,
	goblinHome,
	loadConfig,
	paths,
	splitModelRef,
	thinkingLevels,
	type ThinkingLevel,
} from "./config.ts";
import { openStore } from "./conversation.ts";
import { openJobs } from "./jobs.ts";
import { buildMemoryClient, startMemoryWorker } from "./memory.ts";
import { startScheduler } from "./scheduler.ts";
import { startHttp } from "./http/mod.ts";
import { log, setLogFile, setLogLevel } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { applyMenuButton, AUTH_TELEGRAM_TOKEN, startBot } from "./tg/mod.ts";

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
	const configRef = { current: config };
	const auth = loadAuth();
	const store = openStore(paths.db());
	// Jobs live in the same SQLite file (own connection) — scheduled
	// standing orders, DESIGN.md "Scheduled work".
	const jobs = openJobs(paths.db());

	// ffmpeg powers TTS remuxing and over-cap transcription — probe it once
	// at boot so a missing binary surfaces before the first speech request.
	if (config.transcription || config.tts) {
		void checkFfmpeg(config.tts ? "tts" : "transcription");
	}

	// Warm the openrouter route-capability catalog so /think and the mini app
	// see real per-model thinking levels instead of the cold-start fallback.
	void ensureOpenRouterCatalog();

	// Long-term memory is a boot-time snapshot: the queue binds rows to
	// the endpoint+bank hash, so mini-app memory edits apply on restart —
	// a config change can never redirect queued personal content mid-run.
	const memoryBootConfig = config.memory;
	const memoryClient = buildMemoryClient(memoryBootConfig ?? undefined, auth);
	const memoryState = { lastRecallOk: null as boolean | null };
	const memoryWorker = memoryClient ? startMemoryWorker(store.memoryQueue, memoryClient) : null;
	if (memoryClient && memoryBootConfig) {
		log.info("memory enabled", {
			baseUrl: memoryBootConfig.baseUrl,
			bank: memoryBootConfig.bankId,
		});
	}

	const runtime = new Runtime({
		store,
		async buildStep(conv, tools) {
			const cfg = configRef.current;
			const modelRef = conv.model ?? cfg.model;
			const { provider, modelId } = splitModelRef(modelRef);
			// All may be slow (auth "!command", models.dev fetch) — run in
			// parallel inside the same admission window.
			const [model, modalities, contextWindow] = await Promise.all([
				resolveModel(cfg, auth, modelRef),
				inputModalities(provider, modelId),
				contextLimit(provider, modelId),
			]);
			const level: ThinkingLevel = (thinkingLevels as readonly string[]).includes(
				conv.thinking ?? "",
			)
				? (conv.thinking as ThinkingLevel)
				: cfg.thinking;
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
		makeTools: (conv, deliverVoice, recording, deliverFile) => {
			const tts = configRef.current.tts;
			return makeTools(
				paths.workspace(),
				tts && deliverVoice
					? {
							// A per-call voice replaces the whole config voice — Edge
							// derives the language from the voice name, so an
							// alternate voice is an alternate language.
							synthesize: (text, voice) =>
								synthesizeSpeech(text, voice ? { ...tts, voice } : tts),
							deliver: deliverVoice,
							...(recording ? { recording } : {}),
							// The allowlist always carries the default: picking it
							// explicitly is a no-op.
							...(tts.voices?.length
								? { voices: [...new Set([tts.voice, ...tts.voices])] }
								: {}),
						}
					: undefined,
				// The schedule tool pins new jobs to the conversation it runs in.
				{ jobs, chatId: conv.chatId, threadId: conv.threadId },
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
							noteRecall: (ok: boolean) => {
								memoryState.lastRecallOk = ok;
							},
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
						noteRecall: (ok: boolean) => {
							memoryState.lastRecallOk = ok;
						},
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
		async transcribe(file) {
			// Read per call — a mini-app save applies to the next voice note,
			// no restart.
			const cfg = configRef.current.transcription;
			if (!cfg) return null;
			return transcribeAudio(await transcriptionModel(cfg, auth), file);
		},
		...(memoryClient
			? {
					memory: {
						client: memoryClient,
						contexts: store.memoryContexts,
						queue: store.memoryQueue,
						lastRecallOk: () => memoryState.lastRecallOk,
					},
				}
			: {}),
	});
	const http = startHttp({
		configRef,
		botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
		onConfigWritten: () => {
			setLogLevel(configRef.current.logLevel);
			// publicUrl is operator-editable through the app — keep the menu
			// button (the door) in sync without a restart.
			applyMenuButton(tg.bot.api, configRef.current.publicUrl);
			// Memory is a boot-time snapshot (queue rows bind to the
			// endpoint+bank hash) — a changed block needs a restart.
			if (JSON.stringify(configRef.current.memory ?? null) !== JSON.stringify(memoryBootConfig ?? null)) {
				log.warn("memory config changed — restart to apply");
			}
		},
	});

	// Scheduler after the bot: it submits into conversations and delivers
	// through bot.api — both must exist. The boot scan fires anything
	// missed while the process was down (DESIGN.md, Scheduled work).
	const scheduler = startScheduler({
		jobs,
		store,
		runtime,
		api: tg.bot.api,
		configRef,
		synthesize: (text, tts) => synthesizeSpeech(text, tts),
	});

	return { configRef, auth, store, jobs, runtime, tg, http, scheduler, memoryWorker };
}

let booted: Awaited<ReturnType<typeof boot>>;
try {
	booted = await boot();
} catch (err) {
	log.error("boot failed", err);
	process.exit(1);
}
const { store, jobs, runtime, tg, http, scheduler, memoryWorker } = booted;

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
	// Scheduler first — no new scheduled submits once the drain begins.
	scheduler.stop();
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
	jobs.close();
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
