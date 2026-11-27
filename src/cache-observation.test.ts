import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	NEWEST_TURN_CALL_SQL,
	countCalls,
	listCalls,
	newestTurnCall,
	openCacheObservation,
	type CacheCallInput,
} from "./cache-observation.ts";
import type { Usage } from "./message.ts";
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
}): Usage {
	return {
		inputTokens: over.input,
		inputTokenDetails: {
			noCacheTokens: undefined,
			cacheReadTokens: over.cacheRead,
			cacheWriteTokens: over.cacheWrite,
		},
		outputTokens: over.output,
		outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
		totalTokens: undefined,
	};
}

// A settable clock: begin/finish stamp started_ms/finished_ms off it,
// so idle_ms assertions are exact rather than race-tolerant.
function clock(start = 1_000): { now: () => number; set: (ms: number) => void } {
	let t = start;
	return { now: () => t, set: (ms) => (t = ms) };
}

test("newestTurnCall follows insertion order and skips purpose calls", () => {
	const db = new Database(tmpDb("goblin-cache-newest-"));
	const time = clock(5000);
	const observation = openCacheObservation(db, { now: time.now });
	expect(newestTurnCall(db, "conv-1")).toBeNull();
	observation.begin(input({ callId: "older" }));
	time.set(1000);
	observation.begin(input({ callId: "newest" }));
	observation.begin(input({ callId: "purpose-later", purpose: "review" }));
	expect(newestTurnCall(db, "conv-1")).toBe("newest");
	db.close();
});

test("countCalls counts every call of one conversation", () => {
	const db = new Database(tmpDb("goblin-cache-count-"));
	const observation = openCacheObservation(db, clock());
	observation.begin(input({ callId: "first-a", conversationId: "first" }));
	observation.begin(input({ callId: "first-b", conversationId: "first" }));
	observation.begin(input({ callId: "other", conversationId: "other" }));
	expect(countCalls(db, "first")).toBe(2);
	expect(countCalls(db, "first")).toBe(listCalls(db, "first", 100).length);
	db.close();
});

test("newestTurnCall seeks through an index instead of sorting the conversation", () => {
	const db = new Database(":memory:");
	openCacheObservation(db);
	const plan = db
		.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${NEWEST_TURN_CALL_SQL}`)
		.all()
		.map((row) => row.detail)
		.join(" | ");
	expect(plan).toContain("USING INDEX model_cache_calls_turn");
	expect(plan).not.toContain("TEMP B-TREE");
	db.close();
});

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
	test("idleCacheCall carries the latest same-route lifetime and ignores auxiliary calls", () => {
		const db = new Database(":memory:");
		const tick = clock(1_000);
		const obs = openCacheObservation(db, tick);
		obs.begin(input({ callId: "first", routeKey: "r1" })).finish(usage({ input: 120_000 }), 3_600_000);
		tick.set(2_000);
		obs.begin(input({ callId: "other-route", routeKey: "r2" })).finish(usage({ input: 1 }), 300_000);
		tick.set(3_000);
		obs.begin(input({ callId: "purpose", purpose: "summary", routeKey: "r1" }))
			.finish(usage({ input: 1 }), 300_000);
		tick.set(4_000);
		obs.begin(input({ callId: "latest", routeKey: "r1" })).finish(usage({ input: 110_000 }));
		expect(obs.idleCacheCall("conv-1")).toEqual({
			callId: "latest",
			routeKey: "r1",
			startedMs: 4_000,
			inputTokens: 110_000,
			ttlMs: 3_600_000,
		});
		expect(obs.recentConversations(3_000)).toEqual(["conv-1"]);
		db.close();
	});

	test("a lifetime on a different route is not borrowed", () => {
		const db = new Database(":memory:");
		const tick = clock(1_000);
		const obs = openCacheObservation(db, tick);
		obs.begin(input({ callId: "one", routeKey: "r1" })).finish(usage({ input: 120_000 }), 300_000);
		tick.set(2_000);
		obs.begin(input({ callId: "two", routeKey: "r2" })).finish(usage({ input: 120_000 }));
		expect(obs.idleCacheCall("conv-1")?.ttlMs).toBeNull();
		db.close();
	});

	test("opening an old model_cache_calls schema migrates the nullable lifetime column", () => {
		const db = new Database(":memory:");
		db.run(`CREATE TABLE model_cache_calls (
			call_id TEXT PRIMARY KEY, conversation_id TEXT, purpose TEXT, route_key TEXT NOT NULL,
			model TEXT NOT NULL, started_ms INTEGER NOT NULL, finished_ms INTEGER, head_hash TEXT NOT NULL,
			request_hash TEXT NOT NULL, settings_hash TEXT NOT NULL, prompt_hashes TEXT NOT NULL,
			status TEXT NOT NULL, input_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
			output_tokens INTEGER, idle_ms INTEGER, prefix_relation TEXT NOT NULL, shared_messages INTEGER NOT NULL
		)`);
		const obs = openCacheObservation(db, clock());
		obs.begin(input({ callId: "migrated" })).finish(usage({ input: 1 }), 300_000);
		expect(db.query("PRAGMA table_info(model_cache_calls)").all()).toContainEqual(
			expect.objectContaining({ name: "cache_ttl_ms" }),
		);
		expect(rows(db).find((row) => row.call_id === "migrated")).toBeDefined();
		db.close();
	});
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
		obs
			.begin(input({ callId: "missing" }))
			.finish(usage({ input: 10, cacheRead: undefined, cacheWrite: undefined, output: 2 }));
		obs
			.begin(input({ callId: "zero" }))
			.finish(usage({ input: 10, cacheRead: 0, cacheWrite: 0, output: 2 }));
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
		const appended = obs.begin(input({ callId: "b", promptHashes: ["p1", "p2", "p3"] }));
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
		obs.begin(input({ callId: "main-1", purpose: "turn" })).finish(usage({ input: 10, output: 1 }));
		tick.set(2_000);
		obs
			.begin(input({ callId: "comp-1", purpose: "compaction", promptHashes: ["q1"] }))
			.finish(usage({ input: 5, output: 1 }));
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
