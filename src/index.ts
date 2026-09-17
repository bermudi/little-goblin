// Composition root: config → auth → conversations → bot → http.

import { loadAuth } from "./auth.ts";
import { inputModalities } from "./agent/models-dev.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";
import { resolveModel, thinkingOptions } from "./agent/providers.ts";
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
import { log, setLogLevel } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { applyMenuButton, AUTH_TELEGRAM_TOKEN, startBot } from "./tg/mod.ts";

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

const runtime = new Runtime({
	store,
	async buildStep(conv) {
		const cfg = configRef.current;
		const modelRef = conv.model ?? cfg.model;
		const { provider, modelId } = splitModelRef(modelRef);
		// Both may be slow (auth "!command", models.dev fetch) — run in
		// parallel inside the same admission window.
		const [model, modalities] = await Promise.all([
			resolveModel(cfg, auth, modelRef),
			inputModalities(provider, modelId),
		]);
		const level: ThinkingLevel = (thinkingLevels as readonly string[]).includes(
			conv.thinking ?? "",
		)
			? (conv.thinking as ThinkingLevel)
			: cfg.thinking;
		const providerOptions = thinkingOptions(cfg, modelRef, level);
		log.info("model step", { conversation: conv.id, model: modelRef, thinking: level });
		return {
			model,
			system: buildSystemPrompt(conv),
			inputModalities: modalities,
			...(providerOptions ? { providerOptions } : {}),
		};
	},
	makeTools,
});

const bot = await startBot({ configRef, auth, store, runtime });
const http = startHttp({
	configRef,
	botToken: await auth.resolve(AUTH_TELEGRAM_TOKEN),
	onConfigWritten: () => {
		setLogLevel(configRef.current.logLevel);
		// publicUrl is operator-editable through the app — keep the menu
		// button (the door) in sync without a restart.
		applyMenuButton(bot.api, configRef.current.publicUrl);
	},
});

function shutdown(signal: string): void {
	log.info("shutting down", { signal });
	bot.stop();
	http.stop();
	store.close();
	process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info("goblin up", { home: goblinHome() });
