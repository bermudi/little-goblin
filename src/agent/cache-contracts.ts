import type { Config } from "../config.ts";
import { splitModelRef } from "../config.ts";

export const CACHE_CONTRACT_REVIEW_MS = 30 * 24 * 60 * 60 * 1_000;
export const CACHE_CONTRACT_REVIEWED_AT = "2026-10-15T00:00:00.000Z";

export const cacheContractSources = {
	zai: {
		url: "https://docs.z.ai/help/faq",
		fragments: [
			"how long cached content is retained",
			"has not yet been announced",
		],
	},
	openrouter: {
		url: "https://openrouter.ai/docs/guides/best-practices/prompt-caching.md",
		fragments: [
			"Sticky sessions expire after **10 minutes** of inactivity",
			"By default, the cache expires after 5 minutes",
			"extend this to 1 hour",
		],
	},
	anthropic: {
		url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
		fragments: [
			"By default, the cache has a 5-minute lifetime",
			"The cache is refreshed for no additional cost each time the cached content is used",
		],
	},
	openai: {
		url: "https://developers.openai.com/api/docs/guides/prompt-caching",
		fragments: [
			"minimum cache lifetime",
			"though OpenAI may retain it longer",
		],
	},
	logfare: {
		url: "https://logfare.ai/docs",
		fragments: [],
	},
} as const;

export type CacheSourceId = keyof typeof cacheContractSources;
export type CacheContractId =
	| "zai"
	| "openrouter-anthropic"
	| "openrouter"
	| "openai"
	| "codex"
	| "logfare"
	| "unknown";

export interface CacheContract {
	id: CacheContractId;
	sources: readonly CacheSourceId[];
	mode: "implicit" | "explicit" | "route-dependent" | "unknown";
	lifetime: "rolling-expiry" | "model-dependent-minimum-or-range" | "unpublished" | "unknown";
	idleExpiryMs: number | null;
	requiresExplicitControls: boolean;
	detail: string;
}

const contracts: Readonly<Record<CacheContractId, CacheContract>> = {
	zai: {
		id: "zai",
		sources: ["zai"],
		mode: "implicit",
		lifetime: "unpublished",
		idleExpiryMs: null,
		requiresExplicitControls: false,
		detail: "Automatic caching; Z.AI does not publish retention. No documented idle-expiry gate.",
	},
	"openrouter-anthropic": {
		id: "openrouter-anthropic",
		sources: ["openrouter", "anthropic"],
		mode: "explicit",
		lifetime: "rolling-expiry",
		idleExpiryMs: 5 * 60 * 1_000,
		requiresExplicitControls: true,
		detail:
			"Anthropic cache controls use a rolling 5-minute default or explicit 1-hour TTL. OpenRouter's 10-minute routing affinity is separate.",
	},
	openrouter: {
		id: "openrouter",
		sources: ["openrouter"],
		mode: "route-dependent",
		lifetime: "unknown",
		idleExpiryMs: null,
		requiresExplicitControls: false,
		detail: "Caching depends on the serving model/provider. Routing-affinity expiry is not cache expiry.",
	},
	openai: {
		id: "openai",
		sources: ["openai"],
		mode: "implicit",
		lifetime: "model-dependent-minimum-or-range",
		idleExpiryMs: null,
		requiresExplicitControls: false,
		detail: "Retention depends on model/settings; a documented minimum lifetime is not an expiry bound.",
	},
	codex: {
		id: "codex",
		sources: [],
		mode: "unknown",
		lifetime: "unknown",
		idleExpiryMs: null,
		requiresExplicitControls: false,
		detail: "ChatGPT/Codex backend retention is unverified; OpenAI API retention is not inherited.",
	},
	logfare: {
		id: "logfare",
		sources: ["logfare"],
		mode: "unknown",
		lifetime: "unknown",
		idleExpiryMs: null,
		requiresExplicitControls: false,
		detail: "The reviewed public API page does not establish a prompt-cache lifetime.",
	},
	unknown: {
		id: "unknown",
		sources: [],
		mode: "unknown",
		lifetime: "unknown",
		idleExpiryMs: null,
		requiresExplicitControls: false,
		detail: "OpenAI-compatible protocol does not establish the upstream cache contract.",
	},
};

export function cacheContractFor(config: Config, modelRef: string): CacheContract {
	const { provider, modelId } = splitModelRef(modelRef);
	const entry = config.providers[provider];
	if (entry === undefined) return contracts.unknown;
	if (entry.kind === "codex") return contracts.codex;
	if (entry.kind === "openrouter")
		return modelId.startsWith("anthropic/") ? contracts["openrouter-anthropic"] : contracts.openrouter;
	const url = new URL(entry.baseUrl);
	if (url.hostname === "api.z.ai") return contracts.zai;
	if (url.hostname === "api.openai.com") return contracts.openai;
	if (url.hostname === "logfare.ai") return contracts.logfare;
	return contracts.unknown;
}

export function cacheContractFresh(now: number): boolean {
	const reviewed = Date.parse(CACHE_CONTRACT_REVIEWED_AT);
	return now >= reviewed && now - reviewed <= CACHE_CONTRACT_REVIEW_MS;
}
