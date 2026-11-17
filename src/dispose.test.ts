import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedReader, tempDir } from "./dispose.ts";

const MKDTEMP_ALLOWLIST = new Map([
	// Cache staging must share cacheRoot's filesystem for atomic publish.
	["agent/skill-fetch.ts", "staging root is under cacheRoot for same-filesystem rename"],
	// Prepared audio returns a cleanup callback to its caller.
	["agent/transcribe-cloud.ts", "prepared audio directory outlives acquisition and is returned with cleanup"],
	// owned by the tools P3 branch; migrate after it lands
	["agent/tools/", "excluded: another branch owns agent tools"],
]);

const GET_READER_ALLOWLIST = new Map([
	["proc.ts", "function-scoped, try/finally releases on every exit"],
	["agent/filter-stream.ts", "stream-lifetime owner: the wrapper's cancel releases it"],
	["agent/providers.ts", "stream-lifetime owner: the wrapper's cancel releases it"],
	["http/check.ts", "function-scoped, try/finally releases on every exit"],
	["health/http.ts", "function-scoped, try/finally releases on every exit"],
	["agent/tools/", "deferred until #657 lands"],
	["agent/transcribe-whistle.ts", "deferred until #657 lands: its readCapped moves to agent/tools/web.ts"],
]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
	}
	return out;
}

describe("disposable resources", () => {
	test("tempDir is removed after throw and return", async () => {
		for (const throws of [true, false]) {
			let path = "";
			try {
				await (async () => {
					await using dir = await tempDir("goblin-dispose-test-");
					path = dir.path;
					if (throws) throw new Error("scope failure");
				})();
			} catch (error) {
				expect(error).toEqual(new Error("scope failure"));
			}
			expect(existsSync(path)).toBe(false);
		}
	});

	test("ownedReader cancels on throw and does not cancel a consumed stream", async () => {
		let cancelled = 0;
		const interrupted = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancelled++;
			},
		});
		try {
			await (async () => {
				await using owner = ownedReader(interrupted);
				await owner.reader.read();
				throw new Error("scope failure");
			})();
		} catch {
			// The scope failure is the cancellation path under test.
		}
		expect(cancelled).toBe(1);

		const finished = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				controller.close();
			},
			cancel() {
				cancelled++;
			},
		});
		await (async () => {
			await using owner = ownedReader(finished);
			await owner.reader.read();
			await owner.reader.read();
		})();
		expect(cancelled).toBe(1);
	});

	test("an errored reader preserves the typed read error during disposal", async () => {
		class TypedErr extends Error {}
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				controller.error(new Error("boom"));
			},
		});
		const read = async (): Promise<void> => {
			await using owner = ownedReader(stream);
			try {
				await owner.reader.read();
				await owner.reader.read();
			} catch {
				throw new TypedErr("typed read failure");
			}
		};
		await expect(read()).rejects.toBeInstanceOf(TypedErr);
	});

	test("bare mkdtemp calls are owned or explicitly explained", () => {
		const offenders = walk(import.meta.dir)
			.filter((file) => file !== join(import.meta.dir, "dispose.ts"))
			.filter((file) => /mkdtemp(?:Sync)?\s*\(/.test(readFileSync(file, "utf8")))
			.map((file) => file.slice(import.meta.dir.length + 1))
			.filter((name) => !name.startsWith("test-helpers/"))
			.filter((name) => !name.startsWith("testkit"))
			.filter(
				(name) =>
					![...MKDTEMP_ALLOWLIST.keys()].some(
						(entry) => entry.endsWith("/") ? name.startsWith(entry) : name === entry,
					),
			);
		expect(offenders, "own temp dirs with `await using tempDir()` (src/dispose.ts) or add a reason to MKDTEMP_ALLOWLIST").toEqual([]);
	});

	test("bare getReader calls are owned or explicitly explained", () => {
		const offenders = walk(import.meta.dir)
			.filter((file) => file !== join(import.meta.dir, "dispose.ts"))
			.map((file) => file.slice(import.meta.dir.length + 1))
			.filter((name) => /getReader\s*\(/.test(readFileSync(join(import.meta.dir, name), "utf8")))
			.filter(
				(name) =>
					![...GET_READER_ALLOWLIST.keys()].some(
						(entry) => entry.endsWith("/") ? name.startsWith(entry) : name === entry,
					),
			);
		expect(
			offenders,
			"own stream readers with `await using ownedReader()` (src/dispose.ts) or add a reason to GET_READER_ALLOWLIST",
		).toEqual([]);
	});

});
