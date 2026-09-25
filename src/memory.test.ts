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
	memoryStatus,
	MemoryContexts,
	startMemoryWorker,
	withMemoryBlocks,
} from "./memory.ts";
import { HindsightClient } from "./hindsight.ts";

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
	id, role: "user", parts: [{ type: "text", text }],
});
const asst = (id: string, text: string): UIMessage => ({
	id, role: "assistant", parts: [{ type: "text", text }],
});

describe("recall query", () => {
	test("empty history asks nothing — no recall without text", () => {
		expect(buildRecallQuery([])).toBe("");
	});

	test("non-text parts never enter the query", () => {
		const q = buildRecallQuery([{
			id: "u1", role: "user",
			parts: [
				{ type: "data-attachment", data: { path: "/x.png" } },
				{ type: "text", text: "remember the lighthouse" },
			],
		}]);
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
			[{ id: "f1", text: "Quiet mornings.", document_id: "exchange/a/1/m", occurred_start: "2026-01-01" }],
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
			conversationId: "dm:1", anchorSeq: 1, userTexts: ["hi"], userIds: ["u1"],
			assistant: { id: "a1", role: "assistant", parts: [{ type: "data-attachment", data: { path: "/x.png" } }] },
			priorContext: "", timestamp: new Date().toISOString(),
		});
		expect(doc).toBeNull();
	});

	test("content labels speakers and skips non-text", () => {
		const doc = buildRetentionDocument({
			conversationId: "dm:1", anchorSeq: 2, userTexts: ["i like quiet"], userIds: ["u2"],
			assistant: {
				id: "a2", role: "assistant",
				parts: [{ type: "text", text: "noted" }, { type: "data-attachment", data: {} }],
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
});

describe("status", () => {
	test("disabled without config; degraded on blocked or failed recall; pending on queued work", () => {
		expect(memoryStatus({ enabled: false, pending: 5, blocked: 1, lastRecallOk: false }).state).toBe("disabled");
		expect(memoryStatus({ enabled: true, pending: 0, blocked: 0, lastRecallOk: true }).state).toBe("healthy");
		expect(memoryStatus({ enabled: true, pending: 2, blocked: 0, lastRecallOk: true }).state).toBe("pending");
		expect(memoryStatus({ enabled: true, pending: 0, blocked: 1, lastRecallOk: true }).state).toBe("degraded");
		expect(memoryStatus({ enabled: true, pending: 0, blocked: 0, lastRecallOk: false }).state).toBe("degraded");
	});
});

describe("client construction", () => {
	test("absent config disables without touching the network", () => {
		expect(buildMemoryClient(undefined, { resolve: async () => "x", has: () => false, names: () => [] })).toBeNull();
	});

	test("present config builds a bound client", () => {
		const client = buildMemoryClient(
			{ baseUrl: "http://127.0.0.1:1", bankId: "g", recallTimeoutMs: 500, maxTokens: 256, budget: "low" },
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
});
