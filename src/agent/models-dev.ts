// Model capability catalogs — what other agent tools already read off
// models.dev. Two catalogs over the shared cached-catalog skeleton
// (catalog-fetch.ts: single-flight fetch, backoff on failure, validated
// disk cache):
//   - models.dev: input modalities (does this model eat image/audio/pdf
//     natively?) + context window limits
//   - openrouter: per-route supported_parameters — the only honest
//     source for whether a routed model takes reasoning_effort, a bare
//     reasoning toggle, or no reasoning at all
// An unavailable catalog degrades conservatively (text-only / unknown),
// never fatally.

import { z } from "zod";
import { paths } from "../config.ts";
import { createCachedCatalog, type CachedCatalog } from "./catalog-fetch.ts";

// ---------- models.dev ----------

const catalogSchema = z.record(
	z.string(),
	z.object({
		models: z
			.record(
				z.string(),
				z.object({
					modalities: z
						.object({
							input: z.array(z.string()).default(["text"]),
						})
						.optional(),
						// Context window limit — the denominator for window
						// utilization logging (DESIGN.md, Cache stability).
					limit: z.object({ context: z.number().optional() }).optional(),
				}),
			)
			.default({}),
	}),
);

type Catalog = z.infer<typeof catalogSchema>;

function parseCatalog(disk: boolean, wire: unknown): Catalog {
	const parsed = catalogSchema.safeParse(wire);
	if (!parsed.success) {
		// "schema" names a fetch that went bad; "cache" names the disk
		// copy — the helper's warn lines carry this message either way.
		throw new Error(`models.dev ${disk ? "cache" : "schema"}: ${parsed.error.message}`);
	}
	return parsed.data;
}

const modelsDev: CachedCatalog<Catalog> = createCachedCatalog<Catalog>({
	name: "models.dev",
	url: "https://models.dev/api.json",
	cachePath: () => paths.modelsDevCache(),
	// Media intake rides this catalog — a stale one means file paths
	// instead of inline attachments.
	staleNote: "media will fall back to file paths",
	parseWire: (wire) => parseCatalog(false, wire),
	parseDisk: (disk) => parseCatalog(true, disk),
	// The wire shape is the disk shape — persisted verbatim.
	toDisk: (catalog) => catalog,
});

// Input modalities for "<provider>/<model-id>" as configured. Falls back to
// scanning every catalog provider for the model id (openrouter keeps full
// "anthropic/claude-…" ids; zai coding-plan models may live under a sibling
// provider key). Text-only when unknown.
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

// Context window (tokens) for "<provider>/<model-id>" as configured, same
// lookup rule as inputModalities. Null when the catalog is cold or doesn't
// list the model — callers treat null as "unknown", never "unlimited".
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

// ---------- openrouter ----------

const openrouterCatalogSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			supported_parameters: z.array(z.string()).default([]),
		}),
	),
});

// The disk cache stores the flattened {modelId: [params...]} shape.
const openrouterCacheSchema = z.record(z.string(), z.array(z.string()));

const openrouter: CachedCatalog<Map<string, Set<string>>> =
	createCachedCatalog<Map<string, Set<string>>>({
		name: "openrouter catalog",
		url: "https://openrouter.ai/api/v1/models",
		cachePath: () => paths.openrouterModelsCache(),
		// thinkingLevelsFor reads this catalog — stale means generic
		// ladders instead of per-route ones.
		staleNote: "thinking levels stay generic",
		parseWire(wire) {
			const parsed = openrouterCatalogSchema.safeParse(wire);
			if (!parsed.success) {
				throw new Error(`openrouter models schema: ${parsed.error.message}`);
			}
			return new Map(parsed.data.data.map((m) => [m.id, new Set(m.supported_parameters)]));
		},
		parseDisk(disk) {
			const parsed = openrouterCacheSchema.safeParse(disk);
			if (!parsed.success) {
				throw new Error(`openrouter cache schema: ${parsed.error.message}`);
			}
			return new Map(Object.entries(parsed.data).map(([id, params]) => [id, new Set(params)]));
		},
		toDisk(catalog) {
			return Object.fromEntries([...catalog].map(([id, p]) => [id, [...p]]));
		},
	});

// Cache read on its own so the shape-validation boundary is testable
// without a network round-trip.
export function readOpenRouterCache(): Map<string, Set<string>> | null {
	return openrouter.readDisk();
}

// Boot warm + cold-read share one flight; a failure backs off and the
// disk cache covers the gap.
export function ensureOpenRouterCatalog(): Promise<Map<
	string,
	Set<string>
> | null> {
	return openrouter.ensure();
}

// Per-route supported_parameters for an openrouter model id, or null when
// the catalog is cold or doesn't list the model — callers must treat null
// as "unknown", never "unsupported". A cold read kicks the fetch so the
// next caller sees the real answer.
export function openrouterSupportedParams(modelId: string): Set<string> | null {
	if (!openrouter.current() && !openrouter.backoffArmed()) {
		void openrouter.ensure();
	}
	return openrouter.current()?.get(modelId) ?? null;
}

// Test hook: prime or clear the sync cache without a network round-trip.
export function _primeOpenRouterCatalog(
	catalog: Map<string, Set<string>> | null,
): void {
	openrouter.prime(catalog);
}

// Test hook: force the next ensure onto the network path with a cold
// in-memory catalog.
export function _resetModelsDevForTest(): void {
	modelsDev.resetForTest();
}

// Test hook: force the next ensure onto the network path with a cold
// in-memory catalog.
export function _resetOpenRouterForTest(): void {
	openrouter.resetForTest();
}
