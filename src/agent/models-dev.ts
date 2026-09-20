// Model capabilities via the models.dev catalog — what other agent tools
// already do. We only need input modalities (does this model eat
// image/audio/pdf natively?). Fetched once, cached in state/, refreshed
// daily. A failing endpoint is retried on a backoff, not on every call —
// the disk cache (or text-only) covers the gap. Unavailable catalog →
// text-only, the conservative answer.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { durableWriteFile } from "../durable.ts";
import { paths } from "../config.ts";
import { log } from "../log.ts";

const API_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Backoff after any failure — an unreachable endpoint must not be hit on
// every media message (the intake chain is serial; a 10s timeout per call
// would stall it).
const RETRY_MS = 10 * 60 * 1000;

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

let catalog: Catalog | null = null;
// Don't hit the network before this time. A successful fetch sets it a
// day out; any failure leaves the RETRY_MS backoff armed below.
let nextFetchAt = 0;
// Concurrent callers share one fetch.
let inflight: Promise<Catalog | null> | null = null;

function ensureCatalog(): Promise<Catalog | null> {
	if (Date.now() < nextFetchAt) return Promise.resolve(catalog);
	inflight ??= refresh().finally(() => {
		inflight = null;
	});
	return inflight;
}

async function refresh(): Promise<Catalog | null> {
	// Arm the backoff first — a failure anywhere below must not send the
	// next caller straight back to the network.
	nextFetchAt = Date.now() + RETRY_MS;
	try {
		const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
		const parsed = catalogSchema.safeParse(await res.json());
		if (!parsed.success) throw new Error(`models.dev schema: ${parsed.error.message}`);
		catalog = parsed.data;
		nextFetchAt = Date.now() + CACHE_TTL_MS;
		try {
			durableWriteFile(paths.modelsDevCache(), JSON.stringify(catalog));
		} catch (err) {
			log.warn("models.dev cache write failed", { error: String(err) });
		}
		return catalog;
	} catch (err) {
		log.warn("models.dev fetch failed — media will fall back to file paths", {
			error: String(err),
		});
		if (catalog) return catalog;
		try {
			const cached = JSON.parse(readFileSync(paths.modelsDevCache(), "utf8")) as unknown;
			const parsed = catalogSchema.safeParse(cached);
			catalog = parsed.success ? parsed.data : null;
		} catch (cacheErr) {
			// ENOENT just means no cache; anything else (corrupt file) is
			// warned and ignored — a bad cache must not break media intake.
			if ((cacheErr as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn("models.dev cache unreadable — ignoring", {
					error: String(cacheErr),
				});
			}
			catalog = null;
		}
		return catalog;
	}
}

// Input modalities for "<provider>/<model-id>" as configured. Falls back to
// scanning every catalog provider for the model id (openrouter keeps full
// "anthropic/claude-…" ids; zai coding-plan models may live under a sibling
// provider key). Text-only when unknown.
export async function inputModalities(provider: string, modelId: string): Promise<Set<string>> {
	const cat = await ensureCatalog();
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
	const cat = await ensureCatalog();
	if (!cat) return null;
	const direct = cat[provider]?.models[modelId]?.limit?.context;
	if (direct !== undefined) return direct;
	for (const p of Object.values(cat)) {
		const found = p.models[modelId]?.limit?.context;
		if (found !== undefined) return found;
	}
	return null;
}

// ---------- OpenRouter per-route capability catalog ----------
//
// openrouter.ai/api/v1/models is public and lists each route's
// supported_parameters — the only honest source for whether a routed
// model takes reasoning_effort, a bare reasoning toggle, or no reasoning
// at all. Same fetch/cache/backoff shape as the models.dev catalog above.

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const openrouterCatalogSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			supported_parameters: z.array(z.string()).default([]),
		}),
	),
});

let openrouterCatalog: Map<string, Set<string>> | null = null;
let openrouterNextFetchAt = 0;
let openrouterInflight: Promise<Map<string, Set<string>> | null> | null = null;

async function refreshOpenRouter(): Promise<Map<string, Set<string>> | null> {
	openrouterNextFetchAt = Date.now() + RETRY_MS;
	try {
		const res = await fetch(OPENROUTER_MODELS_URL, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`openrouter models HTTP ${res.status}`);
		const parsed = openrouterCatalogSchema.safeParse(await res.json());
		if (!parsed.success) {
			throw new Error(`openrouter models schema: ${parsed.error.message}`);
		}
		openrouterCatalog = new Map(
			parsed.data.data.map((m) => [m.id, new Set(m.supported_parameters)]),
		);
		openrouterNextFetchAt = Date.now() + CACHE_TTL_MS;
		try {
			durableWriteFile(
				paths.openrouterModelsCache(),
				JSON.stringify(
					Object.fromEntries(
						[...openrouterCatalog].map(([id, p]) => [id, [...p]]),
					),
				),
			);
		} catch (err) {
			log.warn("openrouter catalog cache write failed", { error: String(err) });
		}
		return openrouterCatalog;
	} catch (err) {
		log.warn("openrouter catalog fetch failed — thinking levels stay generic", {
			error: String(err),
		});
		if (openrouterCatalog) return openrouterCatalog;
		try {
			const cached = JSON.parse(
				readFileSync(paths.openrouterModelsCache(), "utf8"),
			) as Record<string, string[]>;
			openrouterCatalog = new Map(
				Object.entries(cached).map(([id, params]) => [id, new Set(params)]),
			);
		} catch (cacheErr) {
			if ((cacheErr as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn("openrouter catalog cache unreadable — ignoring", {
					error: String(cacheErr),
				});
			}
			openrouterCatalog = null;
		}
		return openrouterCatalog;
	}
}

// Boot warm + cold-read share one flight; a failure backs off RETRY_MS.
export function ensureOpenRouterCatalog(): Promise<Map<
	string,
	Set<string>
> | null> {
	if (Date.now() < openrouterNextFetchAt) {
		return Promise.resolve(openrouterCatalog);
	}
	openrouterInflight ??= refreshOpenRouter().finally(() => {
		openrouterInflight = null;
	});
	return openrouterInflight;
}

// Per-route supported_parameters for an openrouter model id, or null when
// the catalog is cold or doesn't list the model — callers must treat null
// as "unknown", never "unsupported". A cold read kicks the fetch so the
// next caller sees the real answer.
export function openrouterSupportedParams(modelId: string): Set<string> | null {
	if (!openrouterCatalog && Date.now() >= openrouterNextFetchAt) {
		void ensureOpenRouterCatalog();
	}
	return openrouterCatalog?.get(modelId) ?? null;
}

// Test hook: prime or clear the sync cache without a network round-trip.
export function _primeOpenRouterCatalog(
	catalog: Map<string, Set<string>> | null,
): void {
	openrouterCatalog = catalog;
	openrouterNextFetchAt = Date.now() + CACHE_TTL_MS;
}

// Test hook: force the next ensure onto the network path with a cold
// in-memory catalog.
export function _resetOpenRouterForTest(): void {
	openrouterCatalog = null;
	openrouterNextFetchAt = 0;
}
