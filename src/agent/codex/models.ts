// The codex provider's model list. models.dev has no codex key and the
// provider carries no baseUrl to host-match, so the only honest catalog
// is the ChatGPT backend's own /codex/models — account-scoped, so the
// cache is per resolved auth file, not global like models.dev.
//
// Wire contract (probed 2026-11-01, GOBLIN_CODEX_LIVE pins it):
//   GET /backend-api/codex/models?client_version=<semver>
//   Bearer + chatgpt-account-id + OpenAI-Beta + originator headers —
//   the same ones the responses call sends.
//   → {models: [{slug, display_name, priority, visibility,
//       supported_in_api, context_window, input_modalities,
//       supported_reasoning_levels: [{effort}], minimal_client_version, …}]}
// client_version is a capability gate: the server lists only models
// whose minimal_client_version the version satisfies (0.62 → []).

import { createHash } from "node:crypto";
import { z } from "zod";
import { paths } from "../../home-layout.ts";
import { createCachedCatalog, type CachedCatalog } from "../catalog-fetch.ts";
import type { ModelOption } from "../models-dev.ts";
import { codexCredentials, resolveCodexAuthFile } from "./auth.ts";

const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
// The codex-CLI compatibility level this adapter's wire shape was
// written against — the backend gates models on it. Bump deliberately,
// with the live check, never to silence an empty list.
export const CODEX_CLIENT_VERSION = "0.163.0";

export interface CodexModel {
	id: string;
	name: string | null;
	priority: number | null;
	contextWindow: number | null;
}

// Only the fields a consumer reads — the picker's id/name/order and
// the step builder's context window (the account's own window for a
// codex slug, replacing the models.dev borrow). The endpoint also
// returns input_modalities and supported_reasoning_levels; nothing
// consumes them, so they are stripped here rather than persisted dead.
const wireSchema = z.object({
	models: z.array(
		z.object({
			slug: z.string(),
			display_name: z.string().optional(),
			priority: z.number().optional(),
			visibility: z.string().optional(),
			supported_in_api: z.boolean().optional(),
			context_window: z.number().nullable().optional(),
		}),
	),
});

const diskSchema = z.object({
	models: z.array(
		z.object({
			id: z.string(),
			name: z.string().nullable(),
			priority: z.number().nullable(),
			contextWindow: z.number().nullable(),
		}),
	),
});

// "list" is the backend's own picker flag — "hide" rows (gpt-reserve,
// codex-auto-review) are internal lanes, not offered models. An absent
// supported_in_api is unknown, not a refusal.
function toCatalog(models: z.infer<typeof wireSchema>["models"]): CodexModel[] {
	return models
		.filter((m) => m.visibility === "list" && m.supported_in_api !== false)
		.map((m) => ({
			id: m.slug,
			name: m.display_name ?? null,
			priority: m.priority ?? null,
			contextWindow: m.context_window ?? null,
		}))
		.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.id.localeCompare(b.id));
}

// The catalog is account-scoped: each resolved auth file gets its own
// CachedCatalog and cache file, keyed by the path hash (two files may
// hold different accounts; one file's token rotation stays one lane).
const catalogs = new Map<string, CachedCatalog<CodexModel[]>>();

function catalogFor(authPath: string): CachedCatalog<CodexModel[]> {
	const existing = catalogs.get(authPath);
	if (existing) return existing;
	const key = createHash("sha1").update(authPath).digest("hex").slice(0, 16);
	const created = createCachedCatalog<CodexModel[]>({
		name: "codex models",
		url: `${MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`,
		cachePath: () => paths.codexModelsCache(key),
		staleNote: "the codex picker stays typed-ref",
		requestHeaders: async () => {
			const auth = await codexCredentials(authPath);
			return {
				authorization: `Bearer ${auth.tokens.access_token}`,
				...(auth.tokens.account_id
					? { "chatgpt-account-id": auth.tokens.account_id }
					: {}),
				"OpenAI-Beta": "responses=experimental",
				originator: "codex_cli_rs",
			};
		},
		parseWire(wire) {
			const parsed = wireSchema.safeParse(wire);
			if (!parsed.success) {
				throw new Error(`codex models schema: ${parsed.error.message}`);
			}
			return toCatalog(parsed.data.models);
		},
		parseDisk(disk) {
			const parsed = diskSchema.safeParse(disk);
			if (!parsed.success) {
				throw new Error(`codex models cache schema: ${parsed.error.message}`);
			}
			return parsed.data.models;
		},
		toDisk: (models) => ({ models }),
	});
	catalogs.set(authPath, created);
	return created;
}

// Boot warm, like the models.dev and openrouter catalogs.
export function ensureCodexModels(authFile?: string): Promise<CodexModel[] | null> {
	return catalogFor(resolveCodexAuthFile(authFile).path).ensure();
}

// Settings-picker options for a codex provider — the cached account
// list, never awaited on the operator surface. A cold read kicks the
// fetch so the next view sees the real list (the openrouterRoute
// pattern); a missing login degrades to the typed-ref fallback.
export function codexModelOptions(authFile?: string): ModelOption[] {
	const cat = catalogFor(resolveCodexAuthFile(authFile).path);
	const models = cat.current() ?? cat.readDisk();
	if (models === null && !cat.backoffArmed()) void cat.ensure();
	return (models ?? []).map((m) => ({ id: m.id, name: m.name, releaseDate: null }));
}

// Disk/memory only, no refresh kick — the doctor's read: a cold cache
// is "unverified", never a fetch it has no authority to run.
export function codexModelsCached(authFile?: string): CodexModel[] | null {
	const cat = catalogFor(resolveCodexAuthFile(authFile).path);
	return cat.current() ?? cat.readDisk();
}

// The account's own context window for a codex slug — the step
// builder's replacement for the models.dev borrow (models.dev has no
// codex key; a borrowed window guesses from another provider's row).
// Sync read like the picker: memory, else one disk-cache parse; a miss
// kicks the fetch so the next turn sees the real number. null means
// unknown — an unlisted slug or a row without a context_window — never
// "unlimited".
export function codexContextWindow(slug: string, authFile?: string): number | null {
	const cat = catalogFor(resolveCodexAuthFile(authFile).path);
	const models = cat.current() ?? cat.readDisk();
	if (models === null && !cat.backoffArmed()) void cat.ensure();
	return models?.find((m) => m.id === slug)?.contextWindow ?? null;
}

// Test hook.
export function _resetCodexModelsForTest(): void {
	for (const c of catalogs.values()) c.resetForTest();
	catalogs.clear();
}
