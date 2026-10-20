// The recovery guard's pure policy: which invocations execute, which
// consume a grant, which refuse — decided from journaled history alone.

import { describe, expect, test } from "bun:test";
import type { TurnToolCall } from "../turn-journal.ts";
import {
	buildRetryGuard,
	canAuthorizeRetry,
	classifyRetry,
	SAFE_READ_TOOLS,
} from "./retry-guard.ts";

function call(over: Partial<TurnToolCall> & { toolCallId: string }): TurnToolCall {
	return {
		runId: "r",
		name: "probe",
		args: { q: 1 },
		argsHash: "h1",
		state: "completed",
		replayed: false,
		retryConsumed: false,
		retryFromKnown: false,
		result: null,
		error: null,
		beganMs: null,
		settledMs: null,
		resolutionNote: null,
		resolvedMs: null,
		...over,
	};
}

describe("buildRetryGuard", () => {
	test("indexes non-replayed executions and decisions by signature; planned/dispatched/replayed are invisible", () => {
		const guard = buildRetryGuard([
			call({ toolCallId: "done" }),
			call({ toolCallId: "amb", state: "dispatched" }),
			call({ toolCallId: "plan", state: "planned" }),
			call({ toolCallId: "synth", replayed: true }),
			call({ toolCallId: "anon", name: "" }),
			call({ toolCallId: "grant", state: "resolved-retry" }),
		]);
		const entries = guard.get("probe:h1")!;
		expect(entries.map((e) => e.toolCallId)).toEqual(["done", "grant"]);
	});
});

describe("classifyRetry", () => {
	test("an effect with a recorded execution refuses with a structured conflict naming the calls", () => {
		const v = classifyRetry("probe", [
			{ toolCallId: "c1", state: "completed", retryConsumed: false, resolutionNote: null },
		]);
		expect(v.kind).toBe("refuse");
		if (v.kind === "refuse") {
			expect(v.error).toContain("c1");
			expect(v.error).toContain("completed");
			expect(v.error).toContain("authorize");
		}
	});

	test("a failed historical execution refuses the same way", () => {
		const v = classifyRetry("probe", [
			{ toolCallId: "c1", state: "failed", retryConsumed: false, resolutionNote: null },
		]);
		expect(v.kind).toBe("refuse");
	});

	test("an unconsumed grant executes once; consumption is marked", () => {
		const grant = {
			toolCallId: "c-grant",
			state: "resolved-retry" as const,
			retryConsumed: false,
			resolutionNote: null,
		};
		const v = classifyRetry("probe", [grant]);
		expect(v).toEqual({ kind: "execute-grant", grant });
		grant.retryConsumed = true;
		const second = classifyRetry("probe", [
			grant,
			{ toolCallId: "c-done", state: "completed", retryConsumed: false, resolutionNote: null },
		]);
		expect(second.kind).toBe("refuse");
	});

	test("identical grants consume oldest-first — a FIFO of source call ids", () => {
		const g1 = {
			toolCallId: "g1",
			state: "resolved-retry" as const,
			retryConsumed: false,
			resolutionNote: null,
		};
		const g2 = { ...g1, toolCallId: "g2" };
		const first = classifyRetry("probe", [g1, g2]);
		expect(first.kind === "execute-grant" && first.grant.toolCallId).toBe("g1");
		g1.retryConsumed = true;
		const second = classifyRetry("probe", [g1, g2]);
		expect(second.kind === "execute-grant" && second.grant.toolCallId).toBe("g2");
	});

	test("a skipped sibling never cancels a separately authorized execution", () => {
		const grant = {
			toolCallId: "g1",
			state: "resolved-retry" as const,
			retryConsumed: false,
			resolutionNote: null,
		};
		const skip = {
			toolCallId: "s1",
			state: "resolved-skip" as const,
			retryConsumed: false,
			resolutionNote: "do not rerun",
		};
		expect(classifyRetry("probe", [skip, grant])).toEqual({
			kind: "execute-grant",
			grant,
		});
	});

	test("an explicit skip refuses even for a safe read", () => {
		const v = classifyRetry("read_file", [
			{
				toolCallId: "s1",
				state: "resolved-skip",
				retryConsumed: false,
				resolutionNote: null,
			},
		]);
		expect(v.kind).toBe("refuse");
		if (v.kind === "refuse") expect(v.error).toContain("operator skipped");
	});

	test("a matching safe read executes afresh while every other tool name conflicts", () => {
		for (const name of SAFE_READ_TOOLS) {
			expect(
				classifyRetry(name, [
					{
						toolCallId: "c1",
						state: "completed",
						retryConsumed: false,
						resolutionNote: null,
					},
				]),
			).toEqual({ kind: "execute" });
		}
		// bash/script/fetch/unknown stay conservative.
		for (const name of ["bash", "script", "fetch", "web_fetch", "unknown_tool"]) {
			expect(
				classifyRetry(name, [
					{
						toolCallId: "c1",
						state: "completed",
						retryConsumed: false,
						resolutionNote: null,
					},
				]).kind,
			).toBe("refuse");
		}
	});

	test("no history executes normally; only planned/dispatched is no history", () => {
		expect(classifyRetry("probe", undefined)).toEqual({ kind: "execute" });
	});
});

describe("canAuthorizeRetry", () => {
	test("dispatched and known calls take a grant; resolved/planned/replayed never", () => {
		for (const [state, ok] of [
			["dispatched", true],
			["completed", true],
			["failed", true],
			["resolved-done", true],
			["resolved-retry", false],
			["resolved-skip", false],
			["planned", false],
		] as const) {
			expect(canAuthorizeRetry({ state, replayed: false })).toBe(ok);
		}
		expect(canAuthorizeRetry({ state: "completed", replayed: true })).toBe(false);
	});
});
