import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputModalities } from "./models-dev.ts";

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
