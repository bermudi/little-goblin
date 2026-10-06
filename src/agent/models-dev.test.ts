import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetModelsDevForTest,
	_resetOpenRouterForTest,
	ensureOpenRouterCatalog,
	inputModalities,
	inputModalitiesCached,
	contextLimit,
	readOpenRouterCache,
} from "./models-dev.ts";

let dirs: string[] = [];
let prevHome: string | undefined;

function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-mdev-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}

afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("models.dev catalog", () => {
	// Module-level catalog state persists across tests in this file — the
	// backoff window armed here would mask a later test's fetch. One test
	// covers the invariant that was broken: a down endpoint is hit once,
	// then the disk cache serves without another network attempt.
	test("a failed fetch serves the disk cache and backs off the endpoint", async () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "models.dev.json"),
			JSON.stringify({
				testprov: { models: { m1: { modalities: { input: ["text", "image"] } } } },
			}),
		);
		const prevFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			return Promise.reject(new Error("offline"));
		}) as unknown as typeof fetch;
		try {
			const first = await inputModalities("testprov", "m1");
			const second = await inputModalities("testprov", "m1");
			expect(first.has("image")).toBe(true);
			expect(second.has("image")).toBe(true);
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = prevFetch;
			_resetModelsDevForTest();
		}
	});

	// refresh() arms its backoff synchronously on entry, so the pre-fix
	// nextFetchAt-first ensure handed the second same-tick caller a cold
	// null instead of the in-flight fetch — index.ts awaits
	// inputModalities and contextLimit together, so the first turn after
	// every boot ran without a contextWindow. The gate keeps the fetch
	// pending until both callers have entered ensure.
	test("cold catalog: concurrent callers join the in-flight fetch, not null", async () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		_resetModelsDevForTest();
		const prevFetch = globalThis.fetch;
		let calls = 0;
		let resolveFetch!: (res: Response) => void;
		const gate = new Promise<Response>((res) => {
			resolveFetch = res;
		});
		globalThis.fetch = (() => {
			calls++;
			return gate;
		}) as unknown as typeof fetch;
		try {
			// buildStep shape: both lookups start in the same tick.
			const both = Promise.all([
				inputModalities("testprov", "m1"),
				contextLimit("testprov", "m1"),
			]);
			resolveFetch(
				new Response(
					JSON.stringify({
						testprov: {
							models: {
								m1: {
									modalities: { input: ["text", "image"] },
									limit: { context: 123456 },
								},
							},
						},
					}),
				),
			);
			const [mods, limit] = await both;
			expect(mods.has("image")).toBe(true);
			expect(limit).toBe(123456);
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = prevFetch;
			_resetModelsDevForTest();
		}
	});

	// The sync read is the vision tool's registration gate — tool
	// building can't await a fetch. Cold reads null and kick the fetch;
	// warm reads match the async path, including the cross-provider
	// fallback scan and the text-only default for unlisted models.
	test("inputModalitiesCached: cold → null + kicks fetch; warm → the async answer", async () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		_resetModelsDevForTest();
		const prevFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						testprov: {
							models: {
								seer: { modalities: { input: ["text", "image"] } },
								blind: { modalities: { input: ["text"] } },
							},
						},
					}),
				),
			);
		}) as unknown as typeof fetch;
		try {
			expect(inputModalitiesCached("testprov", "seer")).toBeNull();
			await inputModalities("testprov", "seer"); // warm via the kicked fetch
			expect(calls).toBe(1);
			expect(inputModalitiesCached("testprov", "seer")!.has("image")).toBe(true);
			expect(inputModalitiesCached("testprov", "blind")!.has("image")).toBe(false);
			expect(inputModalitiesCached("testprov", "ghost")).toEqual(new Set(["text"]));
			expect(inputModalitiesCached("other", "seer")!.has("image")).toBe(true);
		} finally {
			globalThis.fetch = prevFetch;
			_resetModelsDevForTest();
		}
	});
});

describe("openrouter catalog", () => {
	test("fetches, caches to disk, and serves that cache when the endpoint is down", async () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		_resetOpenRouterForTest();
		const prevFetch = globalThis.fetch;
		let fail = false;
		globalThis.fetch = (async () => {
			if (fail) throw new Error("offline");
			return new Response(
				JSON.stringify({
					data: [{ id: "prov/m1", supported_parameters: ["reasoning", "reasoning_effort"] }],
				}),
			);
		}) as unknown as typeof fetch;
		try {
			const fresh = await ensureOpenRouterCatalog();
			expect(fresh?.get("prov/m1")).toEqual(new Set(["reasoning", "reasoning_effort"]));
			// The successful fetch landed on disk…
			const cached = JSON.parse(
				readFileSync(join(dir, "state", "openrouter-models.json"), "utf8"),
			) as Record<string, string[]>;
			expect(cached).toEqual({ "prov/m1": ["reasoning", "reasoning_effort"] });
			// …and serves the next cold start when the endpoint is down.
			_resetOpenRouterForTest();
			fail = true;
			const cold = await ensureOpenRouterCatalog();
			expect(cold?.get("prov/m1")).toEqual(new Set(["reasoning", "reasoning_effort"]));
		} finally {
			globalThis.fetch = prevFetch;
			_resetOpenRouterForTest();
		}
	});

	// Same invariant as the models.dev join test above: refreshOpenRouter
	// arms its backoff synchronously, so a second same-tick caller must
	// join the flight rather than take the early null.
	test("cold catalog: concurrent callers join the in-flight fetch, not null", async () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		_resetOpenRouterForTest();
		const prevFetch = globalThis.fetch;
		let calls = 0;
		let resolveFetch!: (res: Response) => void;
		const gate = new Promise<Response>((res) => {
			resolveFetch = res;
		});
		globalThis.fetch = (() => {
			calls++;
			return gate;
		}) as unknown as typeof fetch;
		try {
			const a = ensureOpenRouterCatalog();
			const b = ensureOpenRouterCatalog();
			resolveFetch(
				new Response(
					JSON.stringify({
						data: [{ id: "prov/m1", supported_parameters: ["reasoning"] }],
					}),
				),
			);
			const [ra, rb] = await Promise.all([a, b]);
			expect(ra?.get("prov/m1")).toEqual(new Set(["reasoning"]));
			expect(rb?.get("prov/m1")).toEqual(new Set(["reasoning"]));
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = prevFetch;
			_resetOpenRouterForTest();
		}
	});
});

describe("readOpenRouterCache", () => {
	// The disk-boundary invariant: a valid-JSON-wrong-shape cache degrades
	// to null with a warn — the old blind cast built a Set of characters
	// out of a params string and reasoning ladders went silently wrong.
	test("a wrong-shape cache degrades to null, not a Set of characters", () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "openrouter-models.json"),
			JSON.stringify({ "anthropic/claude-sonnet-4.5": "reasoning" }),
		);
		expect(readOpenRouterCache()).toBeNull();
	});

	test("a well-formed cache round-trips into per-model param sets", () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "openrouter-models.json"),
			JSON.stringify({ "a/b": ["reasoning", "reasoning_effort"] }),
		);
		const cat = readOpenRouterCache()!;
		expect(cat.get("a/b")).toEqual(new Set(["reasoning", "reasoning_effort"]));
	});

	test("no cache file: ENOENT → null, cold and silent", () => {
		useHome();
		expect(readOpenRouterCache()).toBeNull();
	});
});
