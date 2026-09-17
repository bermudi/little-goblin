// Model capabilities via the models.dev catalog — what other agent tools
// already do. We only need input modalities (does this model eat
// image/audio/pdf natively?). Fetched once, cached in state/, refreshed
// daily. Unavailable catalog → text-only, the conservative answer.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { durableWriteFile } from "../durable.ts";
import { paths } from "../config.ts";
import { log } from "../log.ts";

const API_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
				}),
			)
			.default({}),
	}),
);

type Catalog = z.infer<typeof catalogSchema>;

let catalog: Catalog | null = null;
let fetchedAt = 0;

async function ensureCatalog(): Promise<Catalog | null> {
	if (catalog && Date.now() - fetchedAt < CACHE_TTL_MS) return catalog;
	try {
		const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
		const parsed = catalogSchema.safeParse(await res.json());
		if (!parsed.success) throw new Error(`models.dev schema: ${parsed.error.message}`);
		catalog = parsed.data;
		fetchedAt = Date.now();
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
