import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	_primeModelsDevForTest,
	_resetModelsDevForTest,
	_resetOpenRouterForTest,
	ensureOpenRouterCatalog,
	contextLimit,
	contextLimitCached,
	inputModalities,
	inputModalitiesCached,
	modelOptionsCached,
	readOpenRouterCache,
} from "./models-dev.ts";
import { useHome } from "../testkit.ts";

describe("models.dev catalog", () => {
	// Module-level catalog state persists across tests — a backoff
	// armed in one test would mask a later test's fetch.
	test("a failed fetch serves the disk cache and backs off the endpoint", async () => {
		const dir = useHome("goblin-mdev-");
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

	// Regression: a nextFetchAt-first ensure handed the second same-tick
	// caller a cold null instead of the in-flight fetch — index.ts awaits
	// inputModalities and contextLimit together, so the first turn after
	// every boot ran without a contextWindow.
	test("cold catalog: concurrent callers join the in-flight fetch, not null", async () => {
		const dir = useHome("goblin-mdev-");
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
			const both = Promise.all([inputModalities("testprov", "m1"), contextLimit("testprov", "m1")]);
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
	// building can't await a fetch.
	test("inputModalitiesCached: cold → null + kicks fetch; warm → the async answer", async () => {
		const dir = useHome("goblin-mdev-");
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

	// The gauge's denominator on a fresh boot: /context must never fetch,
	// but it also mustn't read "unknown" while a perfectly good cache
	// file sits on disk. Memory wins once a turn has warmed it.
	test("contextLimitCached: disk backstop when memory is cold, memory wins once warm", () => {
		const dir = useHome("goblin-mdev-");
		mkdirSync(join(dir, "state"), { recursive: true });
		const cachePath = join(dir, "state", "models.dev.json");
		writeFileSync(
			cachePath,
			JSON.stringify({ testprov: { models: { m1: { limit: { context: 123456 } } } } }),
		);
		_resetModelsDevForTest();
		const prevFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			return Promise.reject(new Error("must not fetch on the cached read path"));
		}) as unknown as typeof fetch;
		try {
			expect(contextLimitCached("testprov", "m1")).toBe(123456);
			expect(calls).toBe(0);
			// Warm memory outranks the disk copy.
			_primeModelsDevForTest({ testprov: { models: { m1: { limit: { context: 999 } } } } });
			expect(contextLimitCached("testprov", "m1")).toBe(999);
			// The reset clears the disk memo too — a gone file reads null,
			// not the stale parse.
			_resetModelsDevForTest();
			rmSync(cachePath);
			expect(contextLimitCached("testprov", "m1")).toBeNull();
		} finally {
			globalThis.fetch = prevFetch;
			_resetModelsDevForTest();
		}
	});
});

describe("model options", () => {
	test("maps configured providers by name, kind, and API host, newest first", () => {
		_primeModelsDevForTest({
			zai: {
				api: "https://api.z.ai/api/paas/v4",
				models: {
					"glm-5.2": { name: "GLM-5.2", release_date: "2026-06-01" },
					"glm-5.3": { name: "GLM-5.3", release_date: "2026-08-14" },
					undated: {},
				},
			},
			openrouter: { models: { "minimax/minimax-m3": { name: "MiniMax M3" } } },
			deepseek: {
				api: "https://api.deepseek.com",
				models: { "deepseek-chat": { name: "DeepSeek Chat" } },
			},
		});
		// Exact name wins; the base URL's host is the fallback for an
		// operator-chosen name, and the sort is newest first with
		// undated entries last.
		expect(modelOptionsCached("zai", "responses", "https://api.z.ai/api/v1")).toEqual([
			{ id: "glm-5.3", name: "GLM-5.3", releaseDate: "2026-08-14" },
			{ id: "glm-5.2", name: "GLM-5.2", releaseDate: "2026-06-01" },
			{ id: "undated", name: null, releaseDate: null },
		]);
		expect(modelOptionsCached("route", "openrouter", undefined)).toEqual([
			{ id: "minimax/minimax-m3", name: "MiniMax M3", releaseDate: null },
		]);
		expect(modelOptionsCached("main", "openai-compatible", "https://api.deepseek.com/v1")).toEqual([
			{ id: "deepseek-chat", name: "DeepSeek Chat", releaseDate: null },
		]);
		expect(modelOptionsCached("unknown", "openai-compatible", "https://elsewhere.test")).toEqual(
			[],
		);
		_resetModelsDevForTest();
	});

	test("a cold memory falls back to the disk cache", () => {
		const dir = useHome("goblin-mdev-");
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "models.dev.json"),
			JSON.stringify({
				testprov: { models: { m1: { name: "Model One", release_date: "2026-01-01" } } },
			}),
		);
		_resetModelsDevForTest();
		expect(modelOptionsCached("testprov", "openai-compatible", undefined)).toEqual([
			{ id: "m1", name: "Model One", releaseDate: "2026-01-01" },
		]);
		_resetModelsDevForTest();
	});
});

describe("openrouter catalog", () => {
	test("fetches, caches to disk, and serves that cache when the endpoint is down", async () => {
		const dir = useHome("goblin-mdev-");
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
			expect(fresh?.get("prov/m1")?.params).toEqual(new Set(["reasoning", "reasoning_effort"]));
			const cached = JSON.parse(
				readFileSync(join(dir, "state", "openrouter-models.json"), "utf8"),
			) as Record<string, { params: string[]; reasoning: unknown }>;
			expect(cached).toEqual({
				"prov/m1": { params: ["reasoning", "reasoning_effort"], reasoning: null },
			});
			_resetOpenRouterForTest();
			fail = true;
			const cold = await ensureOpenRouterCatalog();
			expect(cold?.get("prov/m1")?.params).toEqual(new Set(["reasoning", "reasoning_effort"]));
		} finally {
			globalThis.fetch = prevFetch;
			_resetOpenRouterForTest();
		}
	});

	// Same invariant as the models.dev join test: backoff arms
	// synchronously on entry, so a second same-tick caller must join
	// the flight rather than take the early null.
	test("cold catalog: concurrent callers join the in-flight fetch, not null", async () => {
		const dir = useHome("goblin-mdev-");
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
			expect(ra?.get("prov/m1")?.params).toEqual(new Set(["reasoning"]));
			expect(rb?.get("prov/m1")?.params).toEqual(new Set(["reasoning"]));
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = prevFetch;
			_resetOpenRouterForTest();
		}
	});
});

describe("readOpenRouterCache", () => {
	// Regression: a blind cast once built a Set of characters out of a
	// params string and reasoning ladders went silently wrong.
	test("a wrong-shape cache degrades to null, not a Set of characters", () => {
		const dir = useHome("goblin-mdev-");
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "openrouter-models.json"),
			JSON.stringify({ "anthropic/claude-sonnet-4.5": "reasoning" }),
		);
		expect(readOpenRouterCache()).toBeNull();
	});

	test("a well-formed cache round-trips into per-model routes", () => {
		const dir = useHome("goblin-mdev-");
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "openrouter-models.json"),
			JSON.stringify({
				"a/b": {
					params: ["reasoning", "reasoning_effort"],
					reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] },
				},
			}),
		);
		const cat = readOpenRouterCache()!;
		expect(cat.get("a/b")?.params).toEqual(new Set(["reasoning", "reasoning_effort"]));
		expect(cat.get("a/b")?.reasoning).toEqual({
			mandatory: true,
			supported_efforts: ["max", "high", "low"],
		});
	});

	// The pre-reasoning shape carried params only. Reading it as a
	// reasoning-bearing route would claim per-model truth the file
	// doesn't have — so the whole cache is refused and refetched.
	test("the pre-reasoning cache shape is refused, not half-read", () => {
		const dir = useHome("goblin-mdev-");
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			join(dir, "state", "openrouter-models.json"),
			JSON.stringify({ "a/b": ["reasoning", "reasoning_effort"] }),
		);
		expect(readOpenRouterCache()).toBeNull();
	});

	test("no cache file: ENOENT → null, cold and silent", () => {
		useHome("goblin-mdev-");
		expect(readOpenRouterCache()).toBeNull();
	});
});
