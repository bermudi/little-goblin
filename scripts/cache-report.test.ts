import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../src/testkit.ts";

const SCRIPT = join(import.meta.dir, "cache-report.ts");

function run(lines: unknown[]): { report: Record<string, unknown>; stderr: string; code: number } {
	const path = join(tmpDir(), "goblin.log");
	writeFileSync(
		path,
		lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
	);
	const proc = Bun.spawnSync([process.execPath, SCRIPT, path]);
	return {
		report: JSON.parse(proc.stdout.toString()),
		stderr: proc.stderr.toString(),
		code: proc.exitCode,
	};
}

const ts = "2026-10-16T00:00:00.000Z";
const step = (over: Record<string, unknown>) => ({
	ts,
	level: "info",
	msg: "model step usage",
	inputTokens: null,
	cacheReadTokens: null,
	cacheWriteTokens: null,
	...over,
});
const call = (over: Record<string, unknown>) => ({
	ts,
	level: "info",
	msg: "model call usage",
	callId: "x",
	routeKey: "a".repeat(16),
	inputTokens: null,
	cacheReadTokens: null,
	cacheWriteTokens: null,
	...over,
});

describe("cache-report CLI", () => {
	test("legacy lines aggregate: weighted hit rate, input totals, zero vs missing reads", () => {
		const { report, code } = run([
			step({ inputTokens: 100, cacheReadTokens: 80 }),
			step({ inputTokens: 100, cacheReadTokens: 0 }),
			step({ inputTokens: 50 }),
		]);
		expect(code).toBe(0);
		expect(report.mode).toBe("legacy-unattributed");
		const totals = report.totals as Record<string, number | null>;
		expect(totals.inputTokens).toBe(250);
		expect(totals.inputWithReportedReads).toBe(200);
		expect(totals.cacheReadTokens).toBe(80);
		expect(totals.tokenWeightedHitRate).toBe(0.4);
		expect(totals.zeroReads).toBe(1);
		expect(totals.missingReads).toBe(1);
		expect(totals.steps).toBe(3);
	});

	test("correlated receipts suppress legacy lines; a duplicate callId is rejected", () => {
		const { report } = run([
			call({ callId: "c1", inputTokens: 100, cacheReadTokens: 50 }),
			call({ callId: "c1", inputTokens: 100, cacheReadTokens: 50 }),
			step({ inputTokens: 999, cacheReadTokens: 999 }),
		]);
		expect(report.mode).toBe("correlated");
		expect(report.availableSteps).toBe(1);
		expect(report.invalidUsageLines).toBe(1);
		expect((report.totals as Record<string, number>).inputTokens).toBe(100);
	});

	test("the idle curve includes append/same only — rewrite and first never join a bucket", () => {
		const routeKey = "ab".repeat(8);
		const { report } = run([
			call({
				callId: "c1",
				routeKey,
				inputTokens: 10,
				cacheReadTokens: 5,
				idleMs: 1_000,
				prefixRelation: "append",
			}),
			call({
				callId: "c2",
				routeKey,
				inputTokens: 10,
				cacheReadTokens: 5,
				idleMs: 400_000,
				prefixRelation: "same",
			}),
			call({
				callId: "c3",
				routeKey,
				inputTokens: 10,
				cacheReadTokens: 5,
				idleMs: 1_000,
				prefixRelation: "rewrite",
			}),
			call({
				callId: "c4",
				routeKey,
				inputTokens: 10,
				cacheReadTokens: 5,
				idleMs: null,
				prefixRelation: "first",
			}),
		]);
		expect(report.eligibleCurveSteps).toBe(2);
		const curve = report.curve as { routeKey: string; lowerMs: number; upperMs: number | null }[];
		expect(curve).toHaveLength(2);
		expect(curve.map((b) => b.lowerMs).sort((a, b) => a - b)).toEqual([0, 300_000]);
		for (const bucket of curve) expect(bucket.routeKey).toBe(routeKey);
	});

	test("a reported read above the input count is invalid; 0 is not null", () => {
		const { report } = run([
			call({ callId: "c1", inputTokens: 10, cacheReadTokens: 50 }),
			call({ callId: "c2", inputTokens: 10, cacheReadTokens: 0 }),
			call({ callId: "c3", inputTokens: 10, cacheReadTokens: null }),
		]);
		expect(report.invalidUsageLines).toBe(1);
		const totals = report.totals as Record<string, number>;
		expect(totals.zeroReads).toBe(1);
		expect(totals.missingReads).toBe(1);
		expect(totals.reportedReads).toBe(1);
	});
});
