// Destination history round-trips: the target hash must be derivable
// from the recorded connection (a live client and its recorded row
// always agree), auth key names update in place, unknown targets read
// as null, and a corrupted row fails loud rather than silently
// degrading into forget refusals.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { HindsightClient, hindsightTarget } from "./hindsight.ts";
import { buildDestinationClient } from "./memory.ts";

const dirs: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
function storeAt(): ReturnType<typeof openStore> {
	const dir = mkdtempSync(join(tmpdir(), "goblin-destinations-test-"));
	dirs.push(dir);
	const store = openStore(join(dir, "state.sqlite"));
	stores.push(store);
	return store;
}
// afterEach closes every opened store even on assertion failure — the
// SQLite files live in tmpdirs removed alongside.
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const auth = {
	resolve: () => Promise.reject(new Error("no auth expected in these tests")),
	has: () => false,
	names: () => [],
};

describe("memory destinations", () => {
	test("records a boot destination and reconstructs an agreeing client", () => {
		const store = storeAt();
		const target = store.memoryDestinations.record({
			baseUrl: "http://127.0.0.1:8888/",
			bankId: "goblin",
		});
		expect(target).toBe(hindsightTarget("http://127.0.0.1:8888", "goblin"));
		const recorded = store.memoryDestinations.get(target);
		expect(recorded).toEqual({
			target,
			baseUrl: "http://127.0.0.1:8888/",
			bankId: "goblin",
			auth: null,
		});
		// The reconstructed client hashes to the same target — the whole
		// point: forget's clientForTarget hands back a client whose rows
		// it can actually settle.
		const client = buildDestinationClient(recorded!, auth);
		expect(client.target).toBe(target);
		expect(client).toBeInstanceOf(HindsightClient);
	});

	test("records the auth key name and updates it in place on re-record", () => {
		const store = storeAt();
		const first = store.memoryDestinations.record({
			baseUrl: "https://memory.example.com",
			bankId: "b",
			auth: "hindsight-old",
		});
		expect(store.memoryDestinations.get(first)?.auth).toBe("hindsight-old");
		const second = store.memoryDestinations.record({
			baseUrl: "https://memory.example.com",
			bankId: "b",
			auth: "hindsight-new",
		});
		expect(second).toBe(first);
		expect(store.memoryDestinations.get(second)).toEqual({
			target: first,
			baseUrl: "https://memory.example.com",
			bankId: "b",
			auth: "hindsight-new",
		});
	});

	test("an unknown target reads as null; a corrupted row fails loud", () => {
		const store = storeAt();
		expect(store.memoryDestinations.get("b".repeat(64))).toBeNull();
		const target = store.memoryDestinations.record({
			baseUrl: "http://127.0.0.1:9",
			bankId: "x",
		});
		store.db.run("UPDATE memory_destinations SET base_url = 'not a url' WHERE target = ?", [
			target,
		]);
		expect(() => store.memoryDestinations.get(target)).toThrow();
	});
});
