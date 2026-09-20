import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetOpenRouterForTest,
	ensureOpenRouterCatalog,
	inputModalities,
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
