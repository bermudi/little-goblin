import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { openCacheObservation, type CacheCallInput } from "./cache-observation.ts";
import { tmpDb } from "./testkit.ts";

function input(over: Partial<CacheCallInput> = {}): CacheCallInput {
	return {
		callId: `call-${Math.random().toString(36).slice(2)}`,
		conversationId: "conv-1",
		purpose: null,
		model: "fake/fake-1",
		routeKey: "a".repeat(64),
		headHash: "h".repeat(64),
		requestHash: "r".repeat(64),
		settingsHash: "s".repeat(64),
		promptHashes: ["p1", "p2"],
		...over,
	};
}

function usage(over: {
	input?: number;
	cacheRead?: number | undefined;
	cacheWrite?: number | undefined;
	output?: number;
}): LanguageModelV4Usage {
	return {
		inputTokens: {
			total: over.input,
			noCache: undefined,
			cacheRead: over.cacheRead,
			cacheWrite: over.cacheWrite,
		},
		outputTokens: { total: over.output, text: undefined, reasoning: undefined },
	};
}

// A settable clock: begin/finish stamp started_ms/finished_ms off it,
// so idle_ms assertions are exact rather than race-tolerant.
function clock(start = 1_000): { now: () => number; set: (ms: number) => void } {
	let t = start;
	return { now: () => t, set: (ms) => (t = ms) };
}

type Row = {
	call_id: string;
	conversation_id: string | null;
	purpose: string | null;
	route_key: string;
	model: string;
	started_ms: number;
	finished_ms: number | null;
	head_hash: string;
	request_hash: string;
	settings_hash: string;
	prompt_hashes: string;
	status: string;
	input_tokens: number | null;
	cache_read: number | null;
	cache_write: number | null;
	output_tokens: number | null;
	idle_ms: number | null;
	prefix_relation: string;
	shared_messages: number;
};

function rows(db: Database): Row[] {
	return db.query<Row, []>("SELECT * FROM model_cache_calls ORDER BY started_ms, rowid").all();
}

describe("openCacheObservation", () => {
	test("a started row lands at begin with hashes, before any outcome", () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db, clock());
		const call = obs.begin(input({ callId: "c-1", purpose: "turn" }));
		expect(call.callId).toBe("c-1");
		expect(call.prefixRelation).toBe("first");
		expect(call.idleMs).toBeNull();
		expect(call.sharedMessages).toBe(0);
		const row = rows(db).find((r) => r.call_id === "c-1")!;
		expect(row.status).toBe("started");
		expect(row.finished_ms).toBeNull();
		expect(JSON.parse(row.prompt_hashes)).toEqual(["p1", "p2"]);
		expect(row.prefix_relation).toBe("first");
		db.close();
	});

	test("finish preserves null-vs-zero: unreported counters stay null, reported zero stays 0", () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db, clock());
		obs.begin(input({ callId: "missing" })).finish(
			usage({ input: 10, cacheRead: undefined, cacheWrite: undefined, output: 2 }),
		);
		obs.begin(input({ callId: "zero" })).finish(
			usage({ input: 10, cacheRead: 0, cacheWrite: 0, output: 2 }),
		);
		const missing = rows(db).find((r) => r.call_id === "missing")!;
		expect(missing.status).toBe("completed");
		expect(missing.input_tokens).toBe(10);
		expect(missing.cache_read).toBeNull();
		expect(missing.cache_write).toBeNull();
		const zero = rows(db).find((r) => r.call_id === "zero")!;
		expect(zero.cache_read).toBe(0);
		expect(zero.cache_write).toBe(0);
		db.close();
	});

	test("the lineage read is the previous completed call on the same conversation+route", () => {
		const db = new Database(":memory:");
		const tick = clock(1_000);
		const obs = openCacheObservation(db, tick);
		obs.begin(input({ callId: "a" })).finish(usage({ input: 10, cacheRead: 0, output: 1 }));
		tick.set(5_000);
		const second = obs.begin(input({ callId: "b" }));
		expect(second.prefixRelation).toBe("same");
		expect(second.sharedMessages).toBe(2);
		expect(second.idleMs).toBe(4_000);
		db.close();
	});

	test("append requires an exact prompt prefix and an unchanged head/settings", () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db, clock());
		obs.begin(input({ callId: "a" })).finish(usage({ input: 10, output: 1 }));
		const appended = obs.begin(
			input({ callId: "b", promptHashes: ["p1", "p2", "p3"] }),
		);
		expect(appended.prefixRelation).toBe("append");
		expect(appended.sharedMessages).toBe(2);
		// Same append shape but a different settings surface is a rewrite.
		const reSettings = obs.begin(
			input({
				callId: "c",
				promptHashes: ["p1", "p2", "p3"],
				settingsHash: "x".repeat(64),
			}),
		);
		expect(reSettings.prefixRelation).toBe("rewrite");
		db.close();
	});

	test("a head or settings change with identical prompts is a rewrite, not a cache claim", () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db, clock());
		obs.begin(input({ callId: "a" })).finish(usage({ input: 10, output: 1 }));
		const head = obs.begin(input({ callId: "b", headHash: "z".repeat(64) }));
		expect(head.prefixRelation).toBe("rewrite");
		const settings = obs.begin(input({ callId: "c", settingsHash: "z".repeat(64) }));
		expect(settings.prefixRelation).toBe("rewrite");
		expect(rows(db).find((r) => r.call_id === "b")!.prefix_relation).toBe("rewrite");
		db.close();
	});

	test("failed calls never anchor a successor's idle gap", () => {
		const db = new Database(":memory:");
		const tick = clock(1_000);
		const obs = openCacheObservation(db, tick);
		obs.begin(input({ callId: "a" })).finish(usage({ input: 10, output: 1 }));
		tick.set(2_000);
		obs.begin(input({ callId: "b" })).fail();
		tick.set(6_000);
		const third = obs.begin(input({ callId: "c" }));
		expect(third.idleMs).toBe(5_000);
		expect(third.prefixRelation).toBe("same");
		expect(rows(db).find((r) => r.call_id === "b")!.status).toBe("failed");
		db.close();
	});

	test("a null conversation never borrows lineage; a different route starts fresh", () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db, clock());
		obs.begin(input({ callId: "a" })).finish(usage({ input: 10, output: 1 }));
		const anon1 = obs.begin(input({ callId: "n1", conversationId: null }));
		const anon2 = obs.begin(input({ callId: "n2", conversationId: null }));
		expect(anon1.prefixRelation).toBe("first");
		expect(anon2.prefixRelation).toBe("first");
		expect(anon2.idleMs).toBeNull();
		const otherRoute = obs.begin(input({ callId: "r", routeKey: "b".repeat(64) }));
		expect(otherRoute.prefixRelation).toBe("first");
		expect(otherRoute.idleMs).toBeNull();
		db.close();
	});

	test("telemetry survives a close/reopen of the same database file", () => {
		const path = tmpDb();
		const db = new Database(path);
		openCacheObservation(db, clock())
			.begin(input({ callId: "durable-1" }))
			.finish(usage({ input: 7, cacheRead: 3, output: 1 }));
		db.close();
		const reopened = new Database(path);
		const row = reopened
			.query<{ status: string; cache_read: number }, []>(
				"SELECT status, cache_read FROM model_cache_calls WHERE call_id = 'durable-1'",
			)
			.get();
		expect(row).toEqual({ status: "completed", cache_read: 3 });
		reopened.close();
	});

	test("finish/fail settle once — the first terminal outcome stands", () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db, clock());
		const call = obs.begin(input({ callId: "once" }));
		call.fail();
		call.finish(usage({ input: 99, output: 1 }));
		expect(rows(db).find((r) => r.call_id === "once")!.status).toBe("failed");
		db.close();
	});
});

describe("purpose partitioning", () => {
	test("a compaction success on the same route never anchors the main lineage", () => {
		const db = new Database(":memory:");
		const tick = clock(1_000);
		const obs = openCacheObservation(db, tick);
		obs.begin(input({ callId: "main-1", purpose: "turn" })).finish(
			usage({ input: 10, output: 1 }),
		);
		tick.set(2_000);
		obs.begin(input({ callId: "comp-1", purpose: "compaction", promptHashes: ["q1"] })).finish(
			usage({ input: 5, output: 1 }),
		);
		tick.set(9_000);
		const next = obs.begin(
			input({ callId: "main-2", purpose: "turn", promptHashes: ["p1", "p2", "p3"] }),
		);
		expect(next.prefixRelation).toBe("append");
		expect(next.sharedMessages).toBe(2);
		expect(next.idleMs).toBe(8_000);
		db.close();
	});
});
