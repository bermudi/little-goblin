import { describe, expect, spyOn, test } from "bun:test";
import { log } from "./log.ts";
import { after, deadline, sleep, within } from "./timing.ts";

const tick = (ms: number) => new Promise<void>((resolve) => after(ms, "test tick", resolve));

describe("sleep", () => {
	test("waits the full time without a signal", async () => {
		const started = performance.now();
		await sleep(30);
		expect(performance.now() - started).toBeGreaterThanOrEqual(25);
	});

	test("a stopped turn does not hold its lane for the full wait", async () => {
		const controller = new AbortController();
		const started = performance.now();
		const waiting = sleep(10_000, controller.signal);
		await tick(5);
		controller.abort();
		await waiting;
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("an already-aborted signal returns at once", async () => {
		const started = performance.now();
		await sleep(10_000, AbortSignal.abort());
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe("deadline", () => {
	test("aborts its signal and reports expiry when time runs out", async () => {
		using limit = deadline(10);
		expect(limit.expired()).toBe(false);
		await tick(30);
		expect(limit.signal.aborted).toBe(true);
		expect(limit.expired()).toBe(true);
	});

	test("follows the parent's abort without calling it an expiry", () => {
		const parent = new AbortController();
		using limit = deadline(10_000, parent.signal);
		parent.abort(new Error("operator stop"));
		expect(limit.signal.aborted).toBe(true);
		expect(limit.expired()).toBe(false);
		expect(limit.signal.reason).toBe(parent.signal.reason);
	});

	test("starts aborted under an aborted parent", () => {
		using limit = deadline(10_000, AbortSignal.abort());
		expect(limit.signal.aborted).toBe(true);
		expect(limit.expired()).toBe(false);
	});

	test("disposal disarms the timer and detaches from the parent", async () => {
		const parent = new AbortController();
		const limit = deadline(10, parent.signal);
		limit[Symbol.dispose]();
		parent.abort();
		await tick(30);
		expect(limit.signal.aborted).toBe(false);
		expect(limit.expired()).toBe(false);
	});
});

describe("within", () => {
	test("returns the value when the work settles first", async () => {
		expect(await within(Promise.resolve(7), 1_000)).toEqual({ kind: "settled", value: 7 });
	});

	test("reports a timeout when the work outlasts the bound", async () => {
		const never = new Promise<number>(() => {});
		expect(await within(never, 10)).toEqual({ kind: "timeout" });
	});

	test("reports an abort when the signal fires first", async () => {
		const controller = new AbortController();
		const waiting = within(new Promise<number>(() => {}), 10_000, controller.signal);
		controller.abort();
		expect(await waiting).toEqual({ kind: "aborted" });
		expect(await within(Promise.resolve(1), 10_000, AbortSignal.abort())).toEqual({ kind: "aborted" });
	});

	test("a failed work rejects instead of reading as a timeout", async () => {
		await expect(within(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
	});
});

describe("after", () => {
	test("runs the callback once after the delay", async () => {
		let runs = 0;
		after(10, "test run", () => {
			runs += 1;
		});
		await tick(30);
		expect(runs).toBe(1);
	});

	test("cancel stops a pending callback", async () => {
		let runs = 0;
		after(10, "test cancel", () => {
			runs += 1;
		}).cancel();
		await tick(30);
		expect(runs).toBe(0);
	});

	test("a throwing or rejecting callback is an error line, not a process crash", async () => {
		const error = spyOn(log, "error").mockImplementation(() => {});
		try {
			after(1, "sync throw", () => {
				throw new Error("sync");
			});
			after(1, "async reject", () => Promise.reject(new Error("async")));
			await tick(30);
			const timers = error.mock.calls.map((call) => call[2]);
			expect(timers).toContainEqual({ timer: "sync throw" });
			expect(timers).toContainEqual({ timer: "async reject" });
		} finally {
			error.mockRestore();
		}
	});
});
