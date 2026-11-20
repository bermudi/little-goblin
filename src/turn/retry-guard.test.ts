
import { describe, expect, test } from "bun:test";
import type { TurnToolCall } from "../turn-journal.ts";
import { buildRetryGuard, classifyRetry, type GuardEntry } from "./retry-guard.ts";

function call(over: Partial<TurnToolCall> & { toolCallId: string }): TurnToolCall {
	return {
		runId: "r",
		name: "probe",
		args: { q: 1 },
		argsHash: "h1",
		state: "completed",
		replayed: false,
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

function entry(state: GuardEntry["state"], over: Partial<GuardEntry> = {}): GuardEntry {
	return { toolCallId: "c1", state, resolutionNote: null, ...over };
}

describe("buildRetryGuard", () => {
	test("indexes non-replayed history by signature; planned/dispatched/replayed are invisible", () => {
		const guard = buildRetryGuard([
			call({ toolCallId: "done" }),
			call({ toolCallId: "amb", state: "dispatched" }),
			call({ toolCallId: "plan", state: "planned" }),
			call({ toolCallId: "synth", replayed: true }),
			call({ toolCallId: "anon", name: "" }),
			call({ toolCallId: "legacy", state: "resolved-done" }),
		]);
		const entries = guard.get("probe:h1")!;
		expect(entries.map((e) => e.toolCallId)).toEqual(["done", "legacy"]);
	});
});

describe("classifyRetry", () => {
	test("an effect with a recorded execution refuses with a structured conflict naming the calls", () => {
		const v = classifyRetry("probe", [entry("completed", { toolCallId: "c1" })]);
		expect(v.kind).toBe("refuse");
		if (v.kind === "refuse") {
			expect(v.error).toContain("c1");
			expect(v.error).toContain("completed");
			expect(v.error).toContain("fresh turn");
		}
	});

	test("a failed historical execution refuses the same way", () => {
		expect(classifyRetry("probe", [entry("failed")]).kind).toBe("refuse");
	});

	test("legacy resolved-done and resolved-retry count as executions — no grants remain", () => {
		for (const state of ["resolved-done", "resolved-retry"] as const) {
			const v = classifyRetry("probe", [entry(state)]);
			expect(v.kind).toBe("refuse");
			if (v.kind === "refuse") expect(v.error).toContain(state);
		}
	});

	test("an explicit legacy skip refuses even for a safe read", () => {
		const v = classifyRetry("read_file", [
			entry("resolved-skip", { toolCallId: "s1", resolutionNote: "do not rerun" }),
		]);
		expect(v.kind).toBe("refuse");
		if (v.kind === "refuse") {
			expect(v.error).toContain("operator skipped");
			expect(v.error).toContain("do not rerun");
		}
	});

	test("a skip without a note refuses with the bare skip text", () => {
		const v = classifyRetry("probe", [entry("resolved-skip")]);
		expect(v.kind).toBe("refuse");
		if (v.kind === "refuse") expect(v.error).toContain("operator skipped");
	});

	test("a matching safe read executes afresh while every other tool name conflicts", () => {
		for (const name of ["read_file", "history_search", "memory_search"]) {
			expect(classifyRetry(name, [entry("completed")])).toEqual({ kind: "execute" });
		}
		for (const name of ["bash", "script", "fetch", "web_fetch", "unknown_tool"]) {
			expect(classifyRetry(name, [entry("completed")]).kind).toBe("refuse");
		}
	});

	test("no history executes normally", () => {
		expect(classifyRetry("probe", undefined)).toEqual({ kind: "execute" });
		expect(classifyRetry("probe", [])).toEqual({ kind: "execute" });
	});
});
