import { describe, expect, test } from "bun:test";
import type {
	AppWindowCall,
	AppWindowRun,
	AppWindowToolRun,
} from "../../src/http/app-wire.ts";
import { buildTrajectory } from "./trajectory.ts";

const call = (
	callId: string,
	startedMs: number,
	finishedMs: number | null = startedMs + 10,
	purpose: string | null = null,
): AppWindowCall => ({
	callId,
	purpose,
	model: "test",
	startedMs,
	finishedMs,
	status: "completed",
	inputTokens: 10,
	outputTokens: 1,
	cacheRead: 0,
	cacheWrite: 0,
	prefixRelation: "same",
	sharedMessages: 1,
});

const run = (
	runId: string,
	startedMs: number,
	finishedMs: number | null = startedMs + 100,
	resumedFrom: string | null = null,
): AppWindowRun => ({
	runId,
	startedMs,
	finishedMs,
	status: finishedMs === null ? "running" : "completed",
	resumedFrom,
});

const tool = (
	toolCallId: string,
	beganMs: number,
	settledMs: number | null,
	modelCallId: string | null,
	runId = "r1",
): AppWindowToolRun => ({
	toolCallId,
	runId,
	name: toolCallId,
	state: settledMs === null ? "dispatched" : "completed",
	beganMs,
	settledMs,
	modelCallId,
});

describe("buildTrajectory", () => {
	const now = 1000;

	test("stamps tools on their call and leaves the preceding gap empty", () => {
		const rows = buildTrajectory(
			[call("a", 10, 20), call("b", 60, 80)],
			[tool("t", 30, 40, "b")],
			[run("r1", 0, 100)],
			now,
		);
		expect(rows[0]!.calls[1]!.tools.map((entry) => entry.tool.toolCallId)).toEqual(["t"]);
		expect(rows[0]!.calls[0]!.tools).toHaveLength(0);
	});

	test("unstamped tools fall back to the last finished call", () => {
		const rows = buildTrajectory(
			[call("a", 10, 20), call("b", 60, 80)],
			[tool("t", 30, 40, null)],
			[run("r1", 0, 100)],
			now,
		);
		expect(rows[0]!.calls[0]!.tools).toHaveLength(1);
	});

	test("calls anchor to the last started run or a first fallback row", () => {
		const rows = buildTrajectory([call("before", 5), call("later", 25)], [], [
			run("r1", 10),
			run("r2", 20),
		], now);
		expect(rows).toHaveLength(3);
		expect(rows[0]!.run).toBeNull();
		expect(rows[0]!.calls[0]!.call.callId).toBe("before");
		expect(rows[2]!.calls[0]!.call.callId).toBe("later");
	});

	test("all calls without a matching run share one time-ordered fallback row", () => {
		const rows = buildTrajectory(
			[call("fallback-a", 10), call("fallback-b", 20), call("stamped", 50)],
			[tool("tool", 55, 60, "stamped", "later")],
			[run("later", 40, 100)],
			now,
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.run).toBeNull();
		expect(rows[0]!.calls.map((item) => item.call.callId)).toEqual(["fallback-a", "fallback-b"]);
		expect(rows[1]!.calls[0]!.call.callId).toBe("stamped");
	});

	test("overlapping tools use separate lanes and sequential tools reuse a lane", () => {
		const rows = buildTrajectory([call("a", 10, 100)], [
			tool("one", 20, 50, "a"),
			tool("two", 30, 60, "a"),
			tool("three", 60, 70, "a"),
		], [run("r1", 0, 100)], now);
		expect(rows[0]!.calls[0]!.tools.map((entry) => entry.lane)).toEqual([0, 1, 0]);
		expect(rows[0]!.lanes).toBe(2);
	});

	test("running calls produce a positive span", () => {
		const rows = buildTrajectory([call("a", 10, null)], [], [run("r1", 0, null)], 50);
		expect(rows[0]!.finishedMs).toBeGreaterThan(rows[0]!.startedMs);
	});

	test("an open run ends at the read time, so a running call and its tool reach the right edge", () => {
		const rows = buildTrajectory(
			[call("a", 10, 20), call("b", 60, null)],
			[tool("t", 70, null, "b")],
			[run("r1", 0, null)],
			250,
		);
		expect(rows[0]!.startedMs).toBe(0);
		expect(rows[0]!.finishedMs).toBe(250);
	});

	test("a read time before the last event never shortens a row, and an ended run keeps its end", () => {
		const open = buildTrajectory([call("a", 10, null)], [], [run("r1", 0, null)], 5);
		expect(open[0]!.finishedMs).toBe(10);
		const ended = buildTrajectory([call("a", 10, 20)], [], [run("r1", 0, 100)], 9000);
		expect(ended[0]!.finishedMs).toBe(100);
	});

	test("resumed runs keep the predecessor turn number", () => {
		const rows = buildTrajectory([], [], [run("r1", 0), run("r2", 200, 300, "r1")], now);
		expect(rows.map((row) => [row.turn, row.resumed])).toEqual([
			[1, false],
			[1, true],
		]);
	});

	test("purpose calls are not placed", () => {
		const rows = buildTrajectory([call("purpose", 1, 2, "review")], [], [run("r1", 0)], now);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.calls).toHaveLength(0);
	});
});
