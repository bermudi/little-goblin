// openrouter's per-route supported_parameters is the only honest
// source for whether a routed model takes reasoning_effort, a bare
// reasoning toggle, or none. An unavailable catalog degrades
// conservatively (text-only / unknown), never fatally.

import { z } from "zod";
import { type Config, paths } from "../config.ts";
import { createCachedCatalog, type CachedCatalog } from "./catalog-fetch.ts";

// ---------- models.dev ----------

const catalogSchema = z.record(
	z.string(),
	z.object({
		// The provider's API root — the settings picker matches a
		// configured provider by host when its name isn't a catalog key.
		api: z.string().optional(),
		models: z
			.record(
				z.string(),
				z.object({
					// The picker's friendly label; absent in caches written
					// before it was retained.
					name: z.string().optional(),
					release_date: z.string().optional(),
					modalities: z
						.object({
							input: z.array(z.string()).default(["text"]),
						})
						.optional(),
					// Denominator for window-utilization logging.
					limit: z.object({ context: z.number().optional() }).optional(),
				}),
			)
			.default({}),
	}),
);

type Catalog = z.infer<typeof catalogSchema>;
export type ModelsDevCatalog = Catalog;

function parseCatalog(disk: boolean, wire: unknown): Catalog {
	const parsed = catalogSchema.safeParse(wire);
	if (!parsed.success) {
		// "schema" = the wire fetch went bad; "cache" = the disk copy.
		throw new Error(`models.dev ${disk ? "cache" : "schema"}: ${parsed.error.message}`);
	}
	return parsed.data;
}

const modelsDev: CachedCatalog<Catalog> = createCachedCatalog<Catalog>({
	name: "models.dev",
	url: "https://models.dev/api.json",
	cachePath: () => paths.modelsDevCache(),
	// A stale catalog means file paths instead of inline attachments.
	staleNote: "media will fall back to file paths",
	parseWire: (wire) => parseCatalog(false, wire),
	parseDisk: (disk) => parseCatalog(true, disk),
	// The wire shape is the disk shape — persisted verbatim.
	toDisk: (catalog) => catalog,
});

// Falls back to scanning every catalog provider for the model id —
// openrouter keeps full "anthropic/claude-…" ids; zai coding-plan
// models may live under a sibling provider key. Text-only when unknown.
export async function inputModalities(provider: string, modelId: string): Promise<Set<string>> {
	const cat = await modelsDev.ensure();
	if (!cat) return new Set(["text"]);
	const direct = cat[provider]?.models[modelId]?.modalities?.input;
	if (direct) return new Set(direct);
	for (const p of Object.values(cat)) {
		const found = p.models[modelId]?.modalities?.input;
		if (found) return new Set(found);
	}
	return new Set(["text"]);
}

// For gates that can't await — tool registration runs before
// buildStep's catalog fetch resolves. null when cold (kicks the fetch
// so the next call sees the real answer), text-only when unlisted.
export function inputModalitiesCached(provider: string, modelId: string): Set<string> | null {
	const cat = modelsDev.current();
	if (!cat) {
		if (!modelsDev.backoffArmed()) void modelsDev.ensure();
		return null;
	}
	const direct = cat[provider]?.models[modelId]?.modalities?.input;
	if (direct) return new Set(direct);
	for (const p of Object.values(cat)) {
		const found = p.models[modelId]?.modalities?.input;
		if (found) return new Set(found);
	}
	return new Set(["text"]);
}

// Same lookup rule as inputModalities. Null when the catalog is cold
// or doesn't list the model — callers treat null as "unknown", never
// "unlimited".
export async function contextLimit(provider: string, modelId: string): Promise<number | null> {
	const cat = await modelsDev.ensure();
	if (!cat) return null;
	const direct = cat[provider]?.models[modelId]?.limit?.context;
	if (direct !== undefined) return direct;
	for (const p of Object.values(cat)) {
		const found = p.models[modelId]?.limit?.context;
		if (found !== undefined) return found;
	}
	return null;
}

// For read paths that must never stall on the network (HTTP routes) —
// no fetch kick: the turn path's ensure() warms memory on the first
// real turn, which is also when stored usage appears. A cold memory
// falls back to one lazy disk-cache parse per process (the gauge polls;
// a per-request parse would re-read a megabyte of catalog each time),
// and memory wins once warm.
let diskCatalog: Catalog | null | undefined;

export function contextLimitCached(provider: string, modelId: string): number | null {
	function limitIn(cat: Catalog): number | null {
		const direct = cat[provider]?.models[modelId]?.limit?.context;
		if (direct !== undefined) return direct;
		for (const p of Object.values(cat)) {
			const found = p.models[modelId]?.limit?.context;
			if (found !== undefined) return found;
		}
		return null;
	}
	const mem = modelsDev.current();
	if (mem !== null) return limitIn(mem);
	if (diskCatalog === undefined) diskCatalog = modelsDev.readDisk();
	return diskCatalog === null ? null : limitIn(diskCatalog);
}

export interface ModelOption {
	id: string;
	name: string | null;
	releaseDate: string | null;
}

// A configured provider's catalog key: its own name first, then the
// kinds with one obvious homes catalog, then the API host (names are
// operator-chosen; a "deepseek" link may be called "main").
function providerCatalogKey(
	cat: Catalog,
	provider: string,
	kind: string,
	baseUrl: string | undefined,
): string | null {
	if (cat[provider] !== undefined) return provider;
	if (kind === "openrouter" && cat.openrouter !== undefined) return "openrouter";
	if (baseUrl === undefined) return null;
	let host: string;
	try {
		host = new URL(baseUrl).host;
	} catch {
		return null;
	}
	for (const [key, entry] of Object.entries(cat)) {
		if (entry.api === undefined) continue;
		try {
			if (new URL(entry.api).host === host) return key;
		} catch {
			// A malformed catalog api is a bad entry, not a failed lookup.
		}
	}
	return null;
}

// Settings picker options, sorted newest first. Memory first, then the
// same one lazy disk parse contextLimitCached uses — the operator
// surface must never stall on models.dev, so a cold catalog is an empty
// list and the sheet's typed-ref fallback still works.
export function modelOptionsCached(
	provider: string,
	kind: string,
	baseUrl: string | undefined,
): ModelOption[] {
	const cat = modelsDev.current() ?? (diskCatalog ??= modelsDev.readDisk());
	if (cat === null) return [];
	const key = providerCatalogKey(cat, provider, kind, baseUrl);
	if (key === null) return [];
	return Object.entries(cat[key]?.models ?? {})
		.map(([id, m]) => ({
			id,
			name: m.name ?? null,
			releaseDate: m.release_date ?? null,
		}))
		.sort((a, b) => {
			// ISO dates sort lexically; a missing date lands last.
			const byDate = (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
			return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
		});
}

// Every configured provider's cached options — the picker's catalog on
// both operator and app config views. Cached-only like
// modelOptionsCached: the operator surface never awaits models.dev.
export function modelCatalogFor(config: Config): { provider: string; models: ModelOption[] }[] {
	return Object.entries(config.providers).map(([provider, p]) => ({
		provider,
		models: modelOptionsCached(provider, p.kind, "baseUrl" in p ? p.baseUrl : undefined),
	}));
}

// ---------- openrouter ----------

// The per-model reasoning object: which efforts the route accepts and
// whether reasoning can be switched off
// (openrouter.ai/docs/use-cases/reasoning-tokens → "Discovering per-model
// reasoning options"). Absent on non-reasoning models and on the
// dynamic routers, which pick a model per request.
const openrouterReasoningSchema = z.object({
	mandatory: z.boolean().optional(),
	supported_efforts: z.array(z.string()).nullable().optional(),
	default_effort: z.string().optional(),
	default_enabled: z.boolean().optional(),
	supports_max_tokens: z.boolean().optional(),
});

export interface OpenRouterReasoning {
	mandatory?: boolean | undefined;
	supported_efforts?: string[] | null | undefined;
	default_effort?: string | undefined;
	default_enabled?: boolean | undefined;
	supports_max_tokens?: boolean | undefined;
}

export interface OpenRouterRoute {
	/** The parameters the route advertises. */
	params: Set<string>;
	/** The per-model reasoning object, when the route publishes one. */
	reasoning: OpenRouterReasoning | null;
}

const openrouterCatalogSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			supported_parameters: z.array(z.string()).default([]),
			reasoning: openrouterReasoningSchema.nullable().optional(),
		}),
	),
});

// The disk cache stores {modelId: {params, reasoning}}. The pre-reasoning
// shape ({modelId: [params]}) is refused rather than half-read: a route
// without its reasoning object is "unknown", and unknown routes must not
// look like routes that publish one.
const openrouterCacheSchema = z.record(
	z.string(),
	z.object({
		params: z.array(z.string()),
		reasoning: openrouterReasoningSchema.nullable(),
	}),
);

const openrouter: CachedCatalog<Map<string, OpenRouterRoute>> = createCachedCatalog<
	Map<string, OpenRouterRoute>
>({
	name: "openrouter catalog",
	url: "https://openrouter.ai/api/v1/models",
	cachePath: () => paths.openrouterModelsCache(),
	// The thinking profile reads this catalog — stale means generic
	// ladders instead of per-model ones.
	staleNote: "thinking levels stay generic",
	parseWire(wire) {
		const parsed = openrouterCatalogSchema.safeParse(wire);
		if (!parsed.success) {
			throw new Error(`openrouter models schema: ${parsed.error.message}`);
		}
		return new Map(
			parsed.data.data.map((m) => [
				m.id,
				{ params: new Set(m.supported_parameters), reasoning: m.reasoning ?? null },
			]),
		);
	},
	parseDisk(disk) {
		const parsed = openrouterCacheSchema.safeParse(disk);
		if (!parsed.success) {
			throw new Error(`openrouter cache schema: ${parsed.error.message}`);
		}
		return new Map(
			Object.entries(parsed.data).map(([id, entry]) => [
				id,
				{ params: new Set(entry.params), reasoning: entry.reasoning },
			]),
		);
	},
	toDisk(catalog) {
		return Object.fromEntries(
			[...catalog].map(([id, route]) => [
				id,
				{ params: [...route.params], reasoning: route.reasoning },
			]),
		);
	},
});

// On its own so the shape-validation boundary is testable without a
// network round-trip.
export function readOpenRouterCache(): Map<string, OpenRouterRoute> | null {
	return openrouter.readDisk();
}

export function ensureOpenRouterCatalog(): Promise<Map<string, OpenRouterRoute> | null> {
	return openrouter.ensure();
}

// Boot warm, like the openrouter catalog — names and API hosts in the
// settings picker come from a fresh copy, not a pre-name cache.
export function ensureModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
	return modelsDev.ensure();
}

// A route's advertised parameters and its per-model reasoning object.
// Null when the catalog is cold or doesn't list the route — callers
// must treat null as "unknown", never "unsupported". A cold read kicks
// the fetch so the next caller sees the real answer.
export function openrouterRoute(modelId: string): OpenRouterRoute | null {
	if (!openrouter.current() && !openrouter.backoffArmed()) {
		void openrouter.ensure();
	}
	return openrouter.current()?.get(modelId) ?? null;
}

// Test hook.
export function _primeOpenRouterCatalog(catalog: Map<string, OpenRouterRoute> | null): void {
	openrouter.prime(catalog);
}

// Test hook.
export function _primeModelsDevForTest(catalog: ModelsDevCatalog | null): void {
	modelsDev.prime(catalog);
}

// Test hook.
export function _resetModelsDevForTest(): void {
	modelsDev.resetForTest();
	diskCatalog = undefined;
}

// Test hook.
export function _resetOpenRouterForTest(): void {
	openrouter.resetForTest();
}
