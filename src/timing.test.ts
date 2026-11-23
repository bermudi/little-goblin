import { describe, expect, jest, spyOn, test } from "bun:test";
import { log } from "./log.ts";
import { after, deadline, every, sleep, within } from "./timing.ts";

const tick = (ms: number) => new Promise<void>((resolve) => after(ms, "test tick", resolve));

async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("sleep", () => {
	test("waits across the maximum timer delay", async () => {
		jest.useFakeTimers();
		try {
			let settled = false;
			const waiting = sleep(2 ** 31 + 5).then(() => {
				settled = true;
			});
			jest.advanceTimersByTime(2 ** 31 + 4);
			await settle();
			expect(settled).toBe(false);
			jest.advanceTimersByTime(1);
			await settle();
			expect(settled).toBe(true);
			await waiting;
		} finally {
			jest.useRealTimers();
		}
	});

	test("abort cancels a wait across timer chunks", async () => {
		jest.useFakeTimers();
		try {
			const controller = new AbortController();
			let settled = false;
			const waiting = sleep(2 ** 31 + 5, controller.signal).then(() => {
				settled = true;
			});
			jest.advanceTimersByTime(2 ** 31);
			await Promise.resolve();
			expect(settled).toBe(false);
			controller.abort();
			await Promise.resolve();
			expect(settled).toBe(true);
			await waiting;
		} finally {
			jest.useRealTimers();
		}
	});

	test("an infinite wait stays pending until aborted", async () => {
		jest.useFakeTimers();
		try {
			const controller = new AbortController();
			let settled = false;
			const waiting = sleep(Infinity, controller.signal).then(() => {
				settled = true;
			});
			jest.advanceTimersByTime(2 ** 31);
			jest.advanceTimersByTime(2 ** 31);
			await Promise.resolve();
			expect(settled).toBe(false);
			controller.abort();
			await Promise.resolve();
			expect(settled).toBe(true);
			await waiting;
		} finally {
			jest.useRealTimers();
		}
	});

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
	test("expires only after the full long delay and can be disposed", async () => {
		jest.useFakeTimers();
		try {
			const limit = deadline(2 ** 31 + 5);
			jest.advanceTimersByTime(2 ** 31 + 4);
			await Promise.resolve();
			expect(limit.signal.aborted).toBe(false);
			expect(limit.expired()).toBe(false);
			jest.advanceTimersByTime(1);
			expect(limit.signal.aborted).toBe(true);
			expect(limit.expired()).toBe(true);
			const disposed = deadline(2 ** 31 + 5);
			disposed[Symbol.dispose]();
			jest.advanceTimersByTime(2 ** 31 + 10);
			expect(disposed.signal.aborted).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});

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
	test("times out only after the full long delay", async () => {
		jest.useFakeTimers();
		try {
			let settled = false;
			const waiting = within(new Promise<number>(() => {}), 2 ** 31 + 5).then((result) => {
				settled = true;
				return result;
			});
			jest.advanceTimersByTime(2 ** 31 + 4);
			await settle();
			expect(settled).toBe(false);
			jest.advanceTimersByTime(1);
			await settle();
			expect(await waiting).toEqual({ kind: "timeout" });
		} finally {
			jest.useRealTimers();
		}
	});

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
	test("waits across chunks and cancellation survives the first chunk", async () => {
		jest.useFakeTimers();
		try {
			let runs = 0;
			after(2 ** 31 + 5, "long after", () => {
				runs += 1;
			});
			jest.advanceTimersByTime(2 ** 31 + 4);
			expect(runs).toBe(0);
			jest.advanceTimersByTime(1);
			expect(runs).toBe(1);
			const cancelled = after(2 ** 31 + 5, "cancelled long after", () => {
				runs += 1;
			});
			jest.advanceTimersByTime(2 ** 31);
			cancelled.cancel();
			jest.advanceTimersByTime(2 ** 31);
			expect(runs).toBe(1);
		} finally {
			jest.useRealTimers();
		}
	});

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

describe("every", () => {
	test("long intervals repeat only after the full period and cancel", async () => {
		jest.useFakeTimers();
		try {
			let runs = 0;
			const ticker = every(2 ** 31 + 5, "long ticker", () => {
				runs += 1;
			});
			jest.advanceTimersByTime(1);
			expect(runs).toBe(0);
			jest.advanceTimersByTime(2 ** 31 + 3);
			expect(runs).toBe(0);
			jest.advanceTimersByTime(1);
			expect(runs).toBe(1);
			jest.advanceTimersByTime(2 ** 31 + 5);
			expect(runs).toBe(2);
			ticker.cancel();
			jest.advanceTimersByTime(2 ** 31 + 5);
			expect(runs).toBe(2);
		} finally {
			jest.useRealTimers();
		}
	});

	test("an immediate run of a long interval does not bring the next tick forward", () => {
		jest.useFakeTimers();
		try {
			let runs = 0;
			const ticker = every(
				2 ** 31 + 5,
				"long immediate ticker",
				() => {
					runs += 1;
				},
				{ immediate: true },
			);
			expect(runs).toBe(1);
			jest.advanceTimersByTime(2 ** 31 + 4);
			expect(runs).toBe(1);
			jest.advanceTimersByTime(1);
			expect(runs).toBe(2);
			ticker.cancel();
		} finally {
			jest.useRealTimers();
		}
	});

	function counter(target: number): { hit(): number; reached: Promise<void> } {
		let runs = 0;
		let reach!: () => void;
		const reached = new Promise<void>((resolve) => {
			reach = resolve;
		});
		return {
			hit: () => {
				runs += 1;
				if (runs === target) reach();
				return runs;
			},
			reached,
		};
	}

	test("runs the callback on each interval until cancelled", async () => {
		const runs = counter(3);
		let last = 0;
		const ticker = every(5, "test ticker", () => {
			last = runs.hit();
		});
		await runs.reached;
		ticker.cancel();
		const seen = last;
		await tick(40);
		expect(seen).toBe(3);
		expect(last).toBe(seen);
	});

	test("cancel before the first interval means no run", async () => {
		let runs = 0;
		every(10, "test cancel", () => {
			runs += 1;
		}).cancel();
		await tick(30);
		expect(runs).toBe(0);
	});

	test("a throwing or rejecting tick is an error line and the ticker keeps going", async () => {
		const error = spyOn(log, "error").mockImplementation(() => {});
		const syncRuns = counter(2);
		const asyncRuns = counter(2);
		const sync = every(5, "sync throw", () => {
			syncRuns.hit();
			throw new Error("sync");
		});
		const rejecting = every(5, "async reject", () => {
			asyncRuns.hit();
			return Promise.reject(new Error("async"));
		});
		try {
			await Promise.all([syncRuns.reached, asyncRuns.reached]);
			await tick(1);
			const timers = error.mock.calls.map((call) => call[2]);
			expect(timers).toContainEqual({ timer: "sync throw" });
			expect(timers).toContainEqual({ timer: "async reject" });
		} finally {
			sync.cancel();
			rejecting.cancel();
			error.mockRestore();
		}
	});
});
