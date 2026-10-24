// Service catalog for the settings UI — display names for every kind
// id the search/fetch/tts/transcription/provider schemas know, plus
// provider presets. Pure data: no vendor imports, nothing reads the
// network or disk.

import { authDefaults, type CapabilityName, type ProviderConfig } from "./config.ts";

export const serviceNames: Record<string, string> = {
	brave: "Brave Search",
	exa: "Exa",
	jina: "Jina",
	tavily: "Tavily",
	firecrawl: "Firecrawl",
	parallel: "Parallel",
	ddg: "DuckDuckGo",
	local: "Built-in",
	edge: "Edge voices (free)",
	openrouter: "OpenRouter",
	logfare: "Logfare",
	mimo: "Xiaomi MiMo",
	onemin: "1min.AI",
	whistle: "Whistle (on this machine)",
	groq: "Groq",
	openai: "OpenAI",
	mistral: "Mistral",
	elevenlabs: "ElevenLabs",
	gemini: "Google Gemini",
	zai: "Z.ai",
	codex: "ChatGPT",
};

export interface ProviderPreset {
	/** Provider name and auth.jsonl record name — one id is both. */
	id: string;
	name: string;
	provider: ProviderConfig;
}

// Only base URLs this repo's docs already describe. Preset id = the
// provider name = the auth record the wizard asks for.
export const providerPresets: ProviderPreset[] = [
	{
		id: "zai",
		name: "Z.ai",
		provider: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		provider: { kind: "openrouter", auth: "openrouter" },
	},
	{
		id: "onemin",
		name: "1min.AI",
		provider: {
			kind: "openai-compatible",
			baseUrl: "https://api.1min.ai/openai/v1",
			auth: "onemin",
		},
	},
	{
		id: "logfare",
		name: "Logfare",
		provider: {
			kind: "openai-compatible",
			baseUrl: "https://logfare.ai/v1",
			auth: "logfare",
		},
	},
];

// What enabling a capability writes when nothing is parked — absent
// means "needs setup" (the settings GET carries the hint instead).
export const capabilityDefaults: Partial<Record<CapabilityName, unknown>> = {
	sandbox: {},
	scripting: {},
	guest: {},
	reviewer: { auth: authDefaults.openrouter },
};

export const capabilityHints: Record<CapabilityName, string | null> = {
	memory: "run the memory installer (docs/memory.md)",
	transcription: "pick an engine/model",
	vision: "pick an engine/model",
	image: "pick an engine/model",
	sandbox: null,
	subagents: "set it up in goblin.json5 first (docs/configuration.md)",
	scripting: null,
	delegation: "set it up in goblin.json5 first (docs/configuration.md)",
	guest: null,
	reviewer: null,
};
