import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import {
	buildMemoryClient,
	buildRecallQuery,
	buildRetentionDocument,
	documentIdFor,
	formatRecallBlock,
	memoryBoundEntries,
	memoryStatus,
	MemoryContexts,
	startMemoryWorker,
	withMemoryBlocks,
	type MemoryState,
} from "./memory.ts";
import { HindsightClient } from "./hindsight.ts";
import { log } from "./log.ts";
import { MemoryQueue, type MemoryQueueCounts } from "./memory-queue.ts";
import { OUTAGE_NOTICE_AFTER_MS, OutageTracker } from "./memory-outage.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memdb(): Database {
	const dir = mkdtempSync(join(tmpdir(), "goblin-mem-"));
	dirs.push(dir);
	const db = new Database(join(dir, "mem.sqlite"));
	dbs.push(db);
	return db;
}

const user = (id: string, text: string): UIMessage => ({
	id,
	role: "user",
	parts: [{ type: "text", text }],
});
const asst = (id: string, text: string): UIMessage => ({
	id,
	role: "assistant",
	parts: [{ type: "text", text }],
});

describe("recall query", () => {
	test("empty history asks nothing — no recall without text", () => {
		expect(buildRecallQuery([])).toBe("");
	});

	test("non-text parts never enter the query", () => {
		const q = buildRecallQuery([
			{
				id: "u1",
				role: "user",
				parts: [
					{ type: "data-attachment", data: { path: "/x.png" } },
					{ type: "text", text: "remember the lighthouse" },
				],
			},
		]);
		expect(q).toContain("lighthouse");
		expect(q).not.toContain("x.png");
	});

	test("queries are bounded", () => {
		const q = buildRecallQuery([user("u1", "x".repeat(5000))]);
		expect(q.length).toBeLessThanOrEqual(2000);
	});
});

describe("recall formatting", () => {
	test("results, empty, and unavailable are never confused", () => {
		const results = formatRecallBlock(
			[
				{
					id: "f1",
					text: "Quiet mornings.",
					document_id: "exchange/a/1/m",
					occurred_start: "2026-01-01",
				},
			],
			"results",
		);
		const empty = formatRecallBlock([], "empty");
		const down = formatRecallBlock(null, "unavailable");
		expect(results).toContain("Quiet mornings.");
		expect(results).toContain("2026-01-01");
		expect(results).toContain("possibly stale");
		expect(empty).toContain("no relevant memories");
		expect(down).toContain("unavailable");
		expect(down).not.toContain("no relevant memories");
		// Current statements outrank memory — the frame says so.
		expect(results).toContain("Current operator statements take precedence");
	});
});

describe("retention documents", () => {
	test("document IDs are stable per exchange", () => {
		expect(documentIdFor("dm:1", 3, "a-1")).toBe(documentIdFor("dm:1", 3, "a-1"));
		expect(documentIdFor("dm:1", 3, "a-1")).not.toBe(documentIdFor("dm:1", 3, "a-2"));
	});

	test("tool-only turns retain nothing", () => {
		const doc = buildRetentionDocument({
			conversationId: "dm:1",
			anchorSeq: 1,
			userTexts: ["hi"],
			userIds: ["u1"],
			assistant: {
				id: "a1",
				role: "assistant",
				parts: [{ type: "data-attachment", data: { path: "/x.png" } }],
			},
			priorContext: "",
			timestamp: new Date().toISOString(),
		});
		expect(doc).toBeNull();
	});

	test("content labels speakers and skips non-text", () => {
		const doc = buildRetentionDocument({
			conversationId: "dm:1",
			anchorSeq: 2,
			userTexts: ["i like quiet"],
			userIds: ["u2"],
			assistant: {
				id: "a2",
				role: "assistant",
				parts: [
					{ type: "text", text: "noted" },
					{ type: "data-attachment", data: {} },
				],
			},
			priorContext: "talking about mornings",
			timestamp: "2026-09-22T10:00:00Z",
		});
		expect(doc?.id).toBe("exchange/dm:1/2/a2");
		expect(doc?.content).toContain("Operator: i like quiet");
		expect(doc?.content).toContain("Goblin: noted");
		expect(doc?.content).toContain("Context");
		expect(doc?.sourceIds).toContain("a2");
	});
});

describe("recall persistence", () => {
	test("blocks round-trip per conversation in anchor order", () => {
		const ctx = new MemoryContexts(memdb());
		ctx.save("dm:1", 3, "block-three", ["exchange/dm:1/3/a"]);
		ctx.save("dm:1", 1, "block-one", ["exchange/dm:1/1/a"]);
		const loaded = ctx.load("dm:1");
		expect(loaded.map((c) => c.anchorSeq)).toEqual([1, 3]);
		expect(ctx.load("dm:2")).toEqual([]);
	});

	test("suppression survives and gates re-ingestion", () => {
		const ctx = new MemoryContexts(memdb());
		expect(ctx.isSuppressed("exchange/x")).toBe(false);
		ctx.suppress("exchange/x");
		expect(ctx.isSuppressed("exchange/x")).toBe(true);
	});

	test("forgetting redacts only snapshots citing the document", () => {
		const ctx = new MemoryContexts(memdb());
		ctx.save("dm:1", 1, "lighthouse days", ["exchange/dm:1/1/a"]);
		ctx.save("dm:1", 2, "quiet mornings", ["exchange/dm:1/2/b"]);
		expect(ctx.deleteByDocument("exchange/dm:1/1/a")).toBe(1);
		expect(ctx.load("dm:1").map((c) => c.anchorSeq)).toEqual([2]);
	});

	test("unparseable snapshots are redacted, never silently kept", () => {
		const db = memdb();
		const ctx = new MemoryContexts(db);
		ctx.save("dm:1", 1, "quiet mornings", ["exchange/dm:1/1/a"]);
		db.run("UPDATE memory_contexts SET source_ids = 'not-json' WHERE anchor_seq = 1");
		// Fail-closed: a snapshot we cannot prove clean is treated as citing.
		expect(ctx.deleteByDocument("exchange/something-else")).toBe(1);
		expect(ctx.load("dm:1")).toEqual([]);
	});
});

describe("cache-stable materialization", () => {
	const entries = (msgs: UIMessage[]) => msgs.map((m, i) => ({ seq: i + 1, message: m }));

	test("no blocks, no change — disabled memory is byte-identical", () => {
		const h = [user("u1", "hi"), asst("a1", "hello")];
		expect(withMemoryBlocks(entries(h), [], null)).toEqual(h);
	});

	test("blocks ride before their anchored user; turn N+1 extends turn N", () => {
		const turn1 = [user("u1", "i like quiet")];
		const r1 = { anchorSeq: 1, content: "prefers quiet", sourceIds: ["e1"] };
		const req1 = withMemoryBlocks(entries(turn1), [], r1);
		expect(req1.map((m) => m.id)).toEqual(["memory-1", "u1"]);

		const turn2 = [user("u1", "i like quiet"), asst("a1", "noted"), user("u2", "and dark mode")];
		const r2 = { anchorSeq: 3, content: "prefers dark", sourceIds: ["e2"] };
		const req2 = withMemoryBlocks(entries(turn2), [r1], r2);
		expect(req2.map((m) => m.id)).toEqual(["memory-1", "u1", "a1", "memory-3", "u2"]);
		// Turn 1's fused head survives verbatim at the head of turn 2's
		// pre-merge sequence — mergeConsecutiveUsers then fuses each
		// block with its user deterministically on both sides.
		expect(req2.slice(0, 2).map((m) => m.id)).toEqual(req1.map((m) => m.id));
	});

	test("a compaction summary never inherits the boundary's recall block", () => {
		// The synthetic summary takes the boundary event's seq — a block
		// anchored there belongs to the message the summary replaced.
		const view = [
			{ seq: 2, message: user("compact-2", "[history compacted] …") },
			{ seq: 3, message: user("u3", "fresh question") },
		];
		const stale = { anchorSeq: 2, content: "stale evidence", sourceIds: ["e1"] };
		expect(withMemoryBlocks(view, [stale], null).map((m) => m.id)).toEqual(["compact-2", "u3"]);
	});
});

describe("memory-bound projection", () => {
	const entries = (msgs: UIMessage[]) => msgs.map((m, i) => ({ seq: i + 1, message: m }));

	test("drops ineligible events, keeps eligible ones (#85)", () => {
		const view = entries([
			user("u1", "old included"),
			user("u2", "excluded era"),
			user("u3", "fresh"),
		]);
		const filtered = memoryBoundEntries(view, {
			eligibleSeqs: new Set([1, 3]),
			summaryEligible: false,
		});
		expect(filtered.map((e) => e.message.id)).toEqual(["u1", "u3"]);
	});

	test("an ineligible summary drops even when its boundary event is eligible", () => {
		// The synthetic summary rides at the boundary event's seq — its
		// eligibility is the folded span's, never the boundary row's.
		const view = [
			{ seq: 2, message: user("compact-2", "[history compacted] distilled from excluded text") },
			{ seq: 3, message: user("u3", "fresh") },
		];
		const elig = { eligibleSeqs: new Set([2, 3]), summaryEligible: false };
		expect(memoryBoundEntries(view, elig).map((e) => e.message.id)).toEqual(["u3"]);
		elig.summaryEligible = true;
		expect(memoryBoundEntries(view, elig).map((e) => e.message.id)).toEqual(["compact-2", "u3"]);
	});

	test("empty eligibility yields the empty projection — fail closed", () => {
		const view = entries([user("u1", "anything")]);
		expect(memoryBoundEntries(view, { eligibleSeqs: new Set(), summaryEligible: true })).toEqual(
			[],
		);
	});
});

describe("status", () => {
	const counts = (over: Partial<MemoryQueueCounts> = {}): MemoryQueueCounts => ({
		pending: 0,
		submitted: 0,
		completed: 0,
		blocked: 0,
		dismissed: 0,
		...over,
	});
	const input = (over: Partial<Parameters<typeof memoryStatus>[0]> = {}) => ({
		enabled: true,
		counts: counts(),
		lastRecallOk: true,
		lastRecallAt: null,
		blockedDetail: [],
		...over,
	});

	test("disabled without config; degraded on blocked or failed recall; pending on queued work", () => {
		expect(
			memoryStatus(
				input({ enabled: false, counts: counts({ pending: 5, blocked: 1 }), lastRecallOk: false }),
			).state,
		).toBe("disabled");
		expect(memoryStatus(input()).state).toBe("healthy");
		expect(memoryStatus(input({ counts: counts({ submitted: 2 }) })).state).toBe("pending");
		expect(memoryStatus(input({ counts: counts({ blocked: 1 }) })).state).toBe("degraded");
		expect(memoryStatus(input({ lastRecallOk: false })).state).toBe("degraded");
	});

	test("detail says something the state word alone does not", () => {
		const states: MemoryState[] = ["disabled", "healthy", "degraded", "pending"];
		const samples = [
			memoryStatus(input({ enabled: false })),
			memoryStatus(input()),
			memoryStatus(input({ counts: counts({ blocked: 2 }) })),
			memoryStatus(input({ lastRecallOk: false })),
			memoryStatus(input({ counts: counts({ pending: 3 }) })),
		];
		for (const s of samples) {
			expect(s.detail.trim()).not.toBe("");
			// The old redundancy: "memory: healthy — memory healthy".
			expect(s.detail).not.toContain(`memory ${s.state}`);
		}
		expect(states).toHaveLength(4); // every state sampled above
		expect(memoryStatus(input({ counts: counts({ blocked: 1 }) })).detail).toContain(
			"1 blocked retention needs",
		);
		expect(memoryStatus(input({ counts: counts({ blocked: 2 }) })).detail).toContain(
			"2 blocked retentions need",
		);
	});
});

describe("client construction", () => {
	test("absent config disables without touching the network", () => {
		expect(
			buildMemoryClient(undefined, { resolve: async () => "x", has: () => false, names: () => [] }),
		).toBeNull();
	});

	test("present config builds a bound client", () => {
		const client = buildMemoryClient(
			{
				baseUrl: "http://127.0.0.1:1",
				bankId: "g",
				recallTimeoutMs: 500,
				maxTokens: 256,
				budget: "low",
			},
			{ resolve: async () => "x", has: () => true, names: () => ["h"] },
		);
		expect(client).toBeInstanceOf(HindsightClient);
	});
});

describe("worker timer", () => {
	test("stop halts the interval; failures never escape", async () => {
		let calls = 0;
		const fakeQueue = {} as never;
		const fakeClient = {} as never;
		const w = startMemoryWorker(fakeQueue, fakeClient, {
			intervalMs: 5,
			tickFn: async () => {
				calls++;
				throw new Error("service down");
			},
		});
		await Bun.sleep(25);
		await w.stop();
		const frozen = calls;
		await Bun.sleep(20);
		expect(calls).toBe(frozen);
		await w.stop();
	});

	// The review-found race: the notice send is detached from the tick,
	// so two sequential drain ticks can both cross the threshold inside
	// one Telegram round-trip. The episode latch must collapse them into
	// a single send.
	test("duplicate-notice race: sequential failures inside one send round-trip send once", async () => {
		const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
		const db = memdb();
		const queue = new MemoryQueue(db);
		for (const id of ["exchange-a", "exchange-b"]) {
			queue.enqueue(client.target, {
				id,
				conversationId: "dm:1",
				sourceIds: ["u-1", "a-1"],
				timestamp: "2026-09-22T10:00:00Z",
				content: "Operator: hi.\nGoblin: hello.",
			});
		}
		// Pre-age the episode past the threshold with a mutable clock, in
		// outage cadence (a failure every ~5min — a single hour-long clock
		// jump would trip the stale-episode reset instead), so the very
		// first worker failure is already notice-eligible.
		let now = 1_000_000;
		const tracker = new OutageTracker(db, () => now);
		for (let i = 0; i < 13; i++) {
			now += 5 * 60 * 1000;
			tracker.recordFailure("dm:1");
		}
		const sends: number[] = [];
		const held = { release: null as (() => void) | null };
		const w = startMemoryWorker(queue, client, {
			intervalMs: 60_000,
			outage: {
				tracker,
				notify: (_conversationId, sinceMs) =>
					new Promise<void>((resolve) => {
						sends.push(sinceMs);
						held.release = resolve; // hold the send open across the second tick
					}),
			},
		});
		await w.tickNow(); // exchange-a fails transport → notice fired, send pending
		await w.tickNow(); // exchange-b fails transport → latch must suppress
		expect(sends).toHaveLength(1);
		held.release?.();
		await w.stop();
	});

	test("withWorkerPaused holds the timer gate — a pending row stays unclaimed mid-pause", async () => {
		// The /forget quiesce's GATE, not just its drain-await: while a
		// pause holds, the interval must not start a new drain, or a row
		// enqueued mid-pause is submitted behind the delete's back —
		// exactly the resurrect the pause exists to prevent.
		const gates = new Map<string, () => void>();
		const parked = new Map<string, Promise<void>>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				if (request.method === "POST") {
					const body = (await request.json()) as { operation_id?: unknown };
					const op = typeof body.operation_id === "string" ? body.operation_id : "?";
					const park = parked.get(op);
					if (park !== undefined) await park;
					return Response.json({
						success: true,
						bank_id: "g",
						items_count: 1,
						async: true,
						operation_id: op,
					});
				}
				const id = new URL(request.url).pathname.split("/").pop() ?? "";
				return Response.json({ operation_id: id, status: "completed" });
			},
		});
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			const queue = new MemoryQueue(memdb());
			const op1 = queue.enqueue(client.target, {
				id: "exchange-1",
				conversationId: "dm:1",
				sourceIds: ["u1", "a1"],
				timestamp: "2026-09-27T10:00:00Z",
				content: "one",
			});
			parked.set(op1, new Promise<void>((resolve) => gates.set(op1, resolve)));
			const w = startMemoryWorker(queue, client, { intervalMs: 10 });
			// Let the timer start its drain — it claims row 1 and parks
			// inside the submit.
			await Bun.sleep(50);
			// Release row 1; its drain settles on its own (row 2 doesn't
			// exist yet, so the drain finds nothing more and exits).
			gates.get(op1)?.();
			await Bun.sleep(50);
			// Inside the pause: enqueue row 2 and let several intervals fire
			// — the gate must refuse them all. (Without the `pauses > 0`
			// term in the timer gate, a drain starts within ~10 ms and
			// row 2 reads "submitted" here.)
			const out = await w.withWorkerPaused(async () => {
				const op2 = queue.enqueue(client.target, {
					id: "exchange-2",
					conversationId: "dm:1",
					sourceIds: ["u2", "a2"],
					timestamp: "2026-09-27T10:01:00Z",
					content: "two",
				});
				await Bun.sleep(80); // ≥ 8 intervals at 10 ms
				const row2 = queue.get(op2);
				if (!row2) throw new Error("expected row 2");
				return { state: row2.state, op2 };
			});
			expect(out.state).toBe("pending");
			// The pause lifted: the timer drains row 2 now.
			await Bun.sleep(80);
			const settled = queue.get(out.op2);
			expect(settled?.state).toBe("submitted");
			await w.stop();
		} finally {
			server.stop();
		}
	});

	// The 2026-09-25 incident's chat-facing half: a blocked document must
	// surface in chat exactly once, no matter how many times it goes
	// blocked (operator retried it and it blocked again). The latch is
	// the queue's noteBlocked row — committed before the send fires.
	test("a document blocked twice notifies the operator exactly once", async () => {
		const submitted: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				if (request.method === "POST") {
					const body = (await request.json()) as { operation_id?: unknown };
					submitted.push(typeof body.operation_id === "string" ? body.operation_id : "?");
					// 401 is permanent, not retryable: the row goes blocked.
					return new Response("private upstream body", { status: 401 });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			const db = memdb();
			const queue = new MemoryQueue(db);
			queue.enqueue(client.target, {
				id: "exchange-1",
				conversationId: "dm:1",
				sourceIds: ["u-1", "a-1"],
				timestamp: "2026-09-22T10:00:00Z",
				content: "Operator: hi.\nGoblin: hello.",
			});
			const notices: { conversationId: string; error: string | null; attempts: number }[] = [];
			const w = startMemoryWorker(queue, client, {
				intervalMs: 60_000,
				blocked: {
					notify: async (conversationId, error, attempts) => {
						notices.push({ conversationId, error, attempts });
					},
				},
			});
			await w.tickNow(); // submit 401 → blocked → first-ever block of this document
			expect(queue.retryBlocked(client.target)).toBe(1); // operator retry, fresh operation id
			await w.tickNow(); // fresh submit 401 → blocked again → latch must suppress
			expect(notices).toHaveLength(1);
			expect(notices[0]?.conversationId).toBe("dm:1");
			expect(notices[0]?.error).toContain("HTTP 401");
			// The retry actually reached the wire under a new operation id.
			expect(submitted).toHaveLength(2);
			expect(submitted[0]).not.toBe(submitted[1]);
			await w.stop();
		} finally {
			server.stop(true);
		}
	});

	// The notice's failure path has no retry — the log line is the only
	// voice it has, so its shape is pinned here: message, error, and the
	// fields that locate the stuck document (review finding 2026-09-25:
	// passing the fields object as the error argument collapsed it to
	// "[object Object]").
	test("a failed blocked-notice send logs with locating fields and never retries", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				if (request.method === "POST") return new Response("no", { status: 401 });
				return Response.json({ results: [] });
			},
		});
		const calls: { msg: string; err: unknown; fields: Record<string, unknown> }[] = [];
		const original = log.error;
		(
			log as { error: (msg: string, err?: unknown, fields?: Record<string, unknown>) => void }
		).error = (msg, err, fields) => {
			calls.push({ msg, err, fields: fields ?? {} });
		};
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			const queue = new MemoryQueue(memdb());
			queue.enqueue(client.target, {
				id: "exchange-9",
				conversationId: "dm:9",
				sourceIds: ["u-9", "a-9"],
				timestamp: "2026-09-22T10:00:00Z",
				content: "Operator: hi.\nGoblin: hello.",
			});
			const w = startMemoryWorker(queue, client, {
				intervalMs: 60_000,
				blocked: {
					notify: async () => {
						throw new Error("telegram unreachable");
					},
				},
			});
			await w.tickNow(); // submit 401 → blocked → latch → notice send throws
			await w.tickNow(); // nothing due: no second attempt, no second log
			expect(calls).toHaveLength(1);
			expect(calls[0]!.msg).toContain("blocked notice failed");
			expect(String(calls[0]!.err)).toContain("telegram unreachable");
			expect(calls[0]!.fields.conversation).toBe("dm:9");
			expect(calls[0]!.fields.document).toBe("exchange-9");
			await w.stop();
		} finally {
			(log as { error: unknown }).error = original;
			server.stop(true);
		}
	});
});
