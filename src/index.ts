// Composition root: config → auth → conversations → bot → http.

import { loadAuth } from "./auth.ts";
import { contextLimit, ensureOpenRouterCatalog, inputModalities } from "./agent/models-dev.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";
import { resolveModel, thinkingOptions } from "./agent/providers.ts";
import { generateTopicTitle } from "./agent/title.ts";
import { checkFfmpeg, transcribeAudio, transcriptionModel } from "./agent/transcribe.ts";
import { synthesizeSpeech } from "./agent/tts.ts";
import { makeTools } from "./agent/tools/mod.ts";
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

	// ffmpeg powers TTS remuxing and over-cap transcription — probe it once
	// at boot so a missing binary surfaces before the first speech request.
	if (config.transcription || config.tts) {
		void checkFfmpeg(config.tts ? "tts" : "transcription");
	}

	// Warm the openrouter route-capability catalog so /think and the mini app
	// see real per-model thinking levels instead of the cold-start fallback.
	void ensureOpenRouterCatalog();

	const runtime = new Runtime({
		store,
		async buildStep(conv) {
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
			const prompt = buildSystemPrompt(conv);
			log.info("model step", {
				conversation: conv.id,
				model: modelRef,
				thinking: level,
				prompt: prompt.sources.join("+"),
			});
			return {
				model,
				system: prompt.text,
				inputModalities: modalities,
				...(contextWindow !== null ? { contextWindow } : {}),
				...(providerOptions ? { providerOptions } : {}),
			};
		},
		makeTools: (deliverVoice) => {
			const tts = configRef.current.tts;
			return makeTools(
				paths.workspace(),
				tts && deliverVoice
					? { synthesize: (text) => synthesizeSpeech(text, tts), deliver: deliverVoice }
					: undefined,
			);
		},
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
				model,
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
	});
	const http = startHttp({
		configRef,
		botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
		onConfigWritten: () => {
			setLogLevel(configRef.current.logLevel);
			// publicUrl is operator-editable through the app — keep the menu
			// button (the door) in sync without a restart.
			applyMenuButton(tg.bot.api, configRef.current.publicUrl);
		},
	});

	return { configRef, auth, store, runtime, tg, http };
}

let booted: Awaited<ReturnType<typeof boot>>;
try {
	booted = await boot();
} catch (err) {
	log.error("boot failed", err);
	process.exit(1);
}
const { store, runtime, tg, http } = booted;

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
