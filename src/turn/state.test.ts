// TurnState unit tests: the lifetime rules (design/runtime-turn.md) —
// what restores, what dies with the attempt, what a snapshot freezes.
// The full turn behavior (warnings riding requests, toolChoice none,
// forced stamps) stays pinned e2e in runtime.test.ts.

import { describe, expect, test } from "bun:test";
import type { JevClient } from "../jev.ts";
import { LOOP_DETECT_CUT, LOOP_DETECT_WARN } from "../loop-detect.ts";
import { LOOP_WINDOW } from "../loop-watchdog.ts";
import { TurnState, type LoopTurnState } from "./state.ts";

const deps = { convId: "c1", watchdog: null, request: "do the thing" };

const loopOf = (over: Partial<LoopTurnState>): LoopTurnState => ({
	detector: { records: [], warned: [] },
	watchdogRing: [],
	watchdogStrikes: 0,
	completedCalls: 0,
	warnings: [],
	cutKind: null,
	forcedKind: null,
	...over,
});

// Flush fire-and-forget verdict chains: decide resolves on a microtask,
// .then/.finally chain a few more.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const decision = (stuck: number) => ({ answers: { stuck }, inputTokens: 0, cost: 0 });

describe("restore and snapshot", () => {
	test("restores every whitelisted field, snapshot round-trips", () => {
		const loop = loopOf({
			detector: { records: [], warned: ["abc:def"] },
			watchdogRing: [{ tool: "bash", args: "a", result: "r", ok: true }],
			watchdogStrikes: 1,
			completedCalls: 41,
			warnings: ["warned once"],
			cutKind: "repeat",
			forcedKind: "repeat",
		});
		expect(new TurnState(deps, loop).snapshot()).toEqual(loop);
		expect(new TurnState(deps, undefined).snapshot()).toEqual(loopOf({}));
	});

	test("restore copies — attempts off one snapshot are independent of it and each other", () => {
		const snap = new TurnState(deps, loopOf({ warnings: ["w"], completedCalls: 3 })).snapshot();
		const a = new TurnState(deps, snap);
		const b = new TurnState(deps, snap);
		a.noteContextLanding(900, 1000);
		a.issueLanding();
		expect(a.decidedCut()).toBe("context");
		expect(a.forcedCompletion()).toBe("context");
		expect(b.decidedCut()).toBeNull();
		snap.warnings.push("late mutation of the snapshot");
		expect(b.drainWarnings()).toStrictEqual(["w"]);
	});

	test("restored warnings re-send once per attempt — the cursor dies with the attempt", () => {
		const first = new TurnState(deps, loopOf({ warnings: ["w"] }));
		expect(first.drainWarnings()).toStrictEqual(["w"]);
		expect(first.drainWarnings()).toStrictEqual([]);
		// A resume of that same point sends it again.
		const second = new TurnState(deps, first.snapshot());
		expect(second.drainWarnings()).toStrictEqual(["w"]);
	});

	test("snapshot copies — a verdict landing after the snapshot is void", async () => {
		let release: (stuck: number) => void = () => {};
		const gate = new Promise<number>((resolve) => {
			release = resolve;
		});
		const decide: JevClient["decide"] = () => gate.then(decision);
		const state = new TurnState(
			{ convId: "c1", watchdog: { decide, every: 1 }, request: "r" },
			loopOf({ warnings: ["carried"] }),
		);
		state.noteCompletedCall("t", 1, "x", false); // dispatches the check
		const snap = state.snapshot();
		release(0.99); // stuck → warn verdict, after the snapshot
		await tick();
		expect(state.drainWarnings()).toHaveLength(2); // carried + late verdict
		expect(snap.warnings).toStrictEqual(["carried"]);
	});
});

describe("landings", () => {
	test("input at the fill line cuts, below it does not, and an earlier cut keeps ownership", () => {
		const at = new TurnState(deps);
		at.noteContextLanding(850, 1000);
		expect(at.decidedCut()).toBe("context");
		const below = new TurnState(deps);
		below.noteContextLanding(849, 1000);
		expect(below.decidedCut()).toBeNull();
		const unset = new TurnState(deps);
		unset.noteContextLanding(900, undefined);
		expect(unset.decidedCut()).toBeNull();
		const owned = new TurnState(deps, loopOf({ cutKind: "repeat", forcedKind: "repeat" }));
		owned.noteContextLanding(900, 1000);
		expect(owned.decidedCut()).toBe("repeat");
	});

	test("issueLanding fires once per attempt and stamps forcedKind", () => {
		const state = new TurnState(deps);
		state.noteContextLanding(850, 1000);
		expect(state.forcedCompletion()).toBeNull();
		expect(state.issueLanding()).toBe("context");
		expect(state.forcedCompletion()).toBe("context");
		expect(state.isLandingIssued()).toBe(true);
		expect(state.issueLanding()).toBeNull();
	});

	test("a cut the failed attempt decided re-issues in the resume", () => {
		const failed = new TurnState(deps);
		for (let i = 0; i < LOOP_DETECT_CUT; i++) failed.noteCompletedCall("t", 1, "same", false);
		expect(failed.decidedCut()).toBe("repeat");
		const resumed = new TurnState(deps, failed.snapshot());
		expect(resumed.isLandingIssued()).toBe(false); // issued dies with the attempt
		expect(resumed.issueLanding()).toBe("repeat");
	});
});

describe("noteCompletedCall", () => {
	test("identical call+result pairs warn at the threshold, cut at the cut", () => {
		const state = new TurnState(deps);
		for (let i = 0; i < LOOP_DETECT_WARN; i++) state.noteCompletedCall("t", 1, "same", false);
		const warnings = state.drainWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.startsWith("Loop check:")).toBe(true);
		for (let i = LOOP_DETECT_WARN; i < LOOP_DETECT_CUT; i++) {
			state.noteCompletedCall("t", 1, "same", false);
		}
		expect(state.drainWarnings()).toStrictEqual([]); // once per pair
		expect(state.decidedCut()).toBe("repeat");
	});

	test("same call with changing results never warns — progress is not a loop", () => {
		const state = new TurnState(deps);
		for (let i = 0; i < LOOP_DETECT_CUT; i++) state.noteCompletedCall("t", 1, `out ${i}`, false);
		expect(state.drainWarnings()).toStrictEqual([]);
		expect(state.decidedCut()).toBeNull();
	});

	test("the watchdog ring is bounded and shaped per call", () => {
		const decide: JevClient["decide"] = async () => decision(0);
		const state = new TurnState({ convId: "c1", watchdog: { decide, every: 1000 }, request: "r" });
		for (let i = 0; i < LOOP_WINDOW + 4; i++) {
			state.noteCompletedCall("t", i, `r${i}`, false);
		}
		state.noteCompletedCall("t", "x", undefined, false);
		state.noteCompletedCall("t", "y", "boom", true);
		const ring = state.snapshot().watchdogRing;
		expect(ring).toHaveLength(LOOP_WINDOW);
		expect(ring.at(-2)).toMatchObject({ result: "(no result)", ok: true });
		expect(ring.at(-1)).toMatchObject({ result: "boom", ok: false });
	});
});

describe("watchdog cadence", () => {
	test("checks fire on the cadence, carrying the counter and the request", async () => {
		const seen: { request: string; totalToolCalls: number }[] = [];
		const decide: JevClient["decide"] = async (state) => {
			const s = state as { operatorRequest: string; totalToolCalls: number };
			seen.push({ request: s.operatorRequest, totalToolCalls: s.totalToolCalls });
			return decision(0);
		};
		const state = new TurnState(
			// completedCalls restores at 3: the cadence continues across the resume.
			{ convId: "c1", watchdog: { decide, every: 2 }, request: "fix the mail" },
			loopOf({ completedCalls: 3 }),
		);
		state.noteCompletedCall("t", 1, "a", false); // call 4 — fires
		state.noteCompletedCall("t", 2, "b", false); // call 5 — skipped
		await tick();
		state.noteCompletedCall("t", 3, "c", false); // call 6 — fires
		await tick();
		expect(seen).toStrictEqual([
			{ request: "fix the mail", totalToolCalls: 4 },
			{ request: "fix the mail", totalToolCalls: 6 },
		]);
	});

	test("one check in flight at a time", () => {
		let dispatched = 0;
		const decide: JevClient["decide"] = () => {
			dispatched++;
			return new Promise(() => {}); // never settles
		};
		const state = new TurnState({ convId: "c1", watchdog: { decide, every: 1 }, request: "r" });
		state.noteCompletedCall("t", 1, "a", false);
		state.noteCompletedCall("t", 2, "b", false);
		state.noteCompletedCall("t", 3, "c", false);
		expect(dispatched).toBe(1);
	});

	test("two consecutive stuck verdicts cut — the first warns", async () => {
		const decide: JevClient["decide"] = async () => decision(0.9);
		const state = new TurnState({ convId: "c1", watchdog: { decide, every: 1 }, request: "r" });
		state.noteCompletedCall("t", 1, "a", false);
		await tick();
		expect(state.decidedCut()).toBeNull();
		const warned = state.drainWarnings();
		expect(warned).toHaveLength(1);
		expect(warned[0]?.startsWith("Progress check:")).toBe(true);
		state.noteCompletedCall("t", 2, "b", false);
		await tick();
		expect(state.decidedCut()).toBe("watchdog");
		expect(state.issueLanding()).toBe("watchdog");
	});

	test("a sub-threshold check resets the escalation — no cut", async () => {
		const scores = [0.9, 0.1, 0.9];
		let i = 0;
		const decide: JevClient["decide"] = async () => decision(scores[i++] ?? 0);
		const state = new TurnState({ convId: "c1", watchdog: { decide, every: 1 }, request: "r" });
		for (let j = 0; j < 3; j++) {
			state.noteCompletedCall("t", j, `r${j}`, false);
			await tick();
		}
		expect(state.decidedCut()).toBeNull();
		expect(state.drainWarnings()).toHaveLength(2); // warn, reset, warn
	});

	test("an unavailable system1 fails open — the cadence continues", async () => {
		let dispatched = 0;
		const decide: JevClient["decide"] = async () => {
			dispatched++;
			throw new Error("system1 down");
		};
		const state = new TurnState({ convId: "c1", watchdog: { decide, every: 1 }, request: "r" });
		state.noteCompletedCall("t", 1, "a", false);
		await tick();
		state.noteCompletedCall("t", 2, "b", false);
		await tick();
		expect(dispatched).toBe(2);
		expect(state.decidedCut()).toBeNull();
	});
});
