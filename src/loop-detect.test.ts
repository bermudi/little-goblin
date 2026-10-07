import { describe, expect, test } from "bun:test";
import { LOOP_DETECT_CUT, LOOP_DETECT_WARN, LOOP_DETECT_WINDOW, LoopDetector } from "./loop-detect.ts";

describe("loop detector", () => {
	test("an identical call+result warns once at 10 and cuts at 20", () => {
		const d = new LoopDetector();
		const verdicts = Array.from({ length: 25 }, () => d.record("probe", { x: 1 }, "same").action);
		expect(verdicts.slice(0, LOOP_DETECT_WARN - 1).every((a) => a === "none")).toBe(true);
		expect(verdicts[LOOP_DETECT_WARN - 1]).toBe("warn");
		// Warned once per pair: the climb from 10 to 20 stays quiet.
		expect(verdicts.slice(LOOP_DETECT_WARN, LOOP_DETECT_CUT - 1).every((a) => a === "none")).toBe(true);
		expect(verdicts[LOOP_DETECT_CUT - 1]).toBe("cut");
		// The pair stays at/over the cut line for every repeat after.
		expect(verdicts.slice(LOOP_DETECT_CUT).every((a) => a === "cut")).toBe(true);
	});

	test("same args with changing results never trips", () => {
		const d = new LoopDetector();
		for (let i = 0; i < 30; i++) {
			expect(d.record("probe", { x: 1 }, `result ${i}`).action).toBe("none");
		}
	});

	test("argument order does not matter — same call, different key order", () => {
		const d = new LoopDetector();
		for (let i = 0; i < LOOP_DETECT_WARN - 1; i++) {
			d.record("probe", { a: 1, b: 2 }, "r");
		}
		expect(d.record("probe", { b: 2, a: 1 }, "r").action).toBe("warn");
	});

	test("A/B alternation with stable results cuts — each side counts in the window", () => {
		const d = new LoopDetector();
		let firstCut = -1;
		const warns: number[] = [];
		for (let i = 0; i < LOOP_DETECT_WINDOW + 4; i++) {
			const v = i % 2 === 0 ? d.record("edit", { n: "a" }, "ok") : d.record("test", { n: "b" }, "1 fail");
			if (v.action === "warn") warns.push(i);
			if (v.action === "cut" && firstCut === -1) firstCut = i;
		}
		// Each side warns at its own 10th occurrence, then the first side
		// to reach 20 inside the 40-record window cuts.
		expect(warns).toEqual([2 * (LOOP_DETECT_WARN - 1), 2 * (LOOP_DETECT_WARN - 1) + 1]);
		expect(firstCut).toBe(2 * (LOOP_DETECT_CUT - 1));
	});

	test("spread-out repeats beyond the window never trip", () => {
		const d = new LoopDetector();
		// The looped call every 5th record: inside any 40-window it
		// appears at most 8 times — under the warn line, forever.
		for (let i = 0; i < 200; i++) {
			const v =
				i % 5 === 0
					? d.record("probe", { poll: true }, "nothing yet")
					: d.record("work", { i }, `did ${i}`);
			expect(v.action).toBe("none");
		}
	});

	test("state serializes and restores — the count and warned pairs survive", () => {
		const d = new LoopDetector();
		for (let i = 0; i < LOOP_DETECT_WARN - 1; i++) d.record("probe", { x: 1 }, "same");
		const restored = LoopDetector.restore(d.snapshot());
		expect(restored.record("probe", { x: 1 }, "same").action).toBe("warn");
		// The pair is warned — further repeats climb quietly to the cut.
		for (let i = LOOP_DETECT_WARN; i < LOOP_DETECT_CUT - 1; i++) {
			expect(restored.record("probe", { x: 1 }, "same").action).toBe("none");
		}
		expect(restored.record("probe", { x: 1 }, "same").action).toBe("cut");
	});
});
