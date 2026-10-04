import { describe, expect, test } from "bun:test";
import { CoalescingBuffer } from "./buffer.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coalescing buffer", () => {
	test("rapid pushes merge into one flush", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(40, (_k, items) => {
			flushes.push(items);
		});
		buf.push("c1", "a");
		await sleep(15);
		buf.push("c1", "b");
		await sleep(15);
		buf.push("c1", "c");
		await sleep(80);
		expect(flushes).toEqual([["a", "b", "c"]]);
	});

	test("separate conversations flush independently", async () => {
		const seen: Record<string, string[]> = {};
		const buf = new CoalescingBuffer<string>(30, (k, items) => {
			seen[k] = items;
		});
		buf.push("c1", "a");
		buf.push("c2", "x");
		await sleep(60);
		expect(seen.c1).toEqual(["a"]);
		expect(seen.c2).toEqual(["x"]);
	});

	test("drain flushes pending buckets immediately and disarms their timers", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(40, (_k, items) => {
			flushes.push(items);
		});
		buf.push("c1", "a");
		buf.push("c2", "x");
		await buf.drain();
		expect(flushes).toEqual([["a"], ["x"]]);
		await sleep(80); // disarmed timers must not re-fire
		expect(flushes).toEqual([["a"], ["x"]]);
	});

	test("a quiet gap starts a new batch", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(30, (_k, items) => {
			flushes.push(items);
		});
		buf.push("c1", "first");
		await sleep(60);
		buf.push("c1", "second");
		await sleep(60);
		expect(flushes).toEqual([["first"], ["second"]]);
	});

	test("a dribble faster than the quiet window still flushes at the max-wait ceiling", async () => {
		const flushes: string[][] = [];
		// Quiet 40ms, ceiling 70ms: pushes every 25ms reset the quiet
		// timer forever, so only the ceiling can fire.
		const buf = new CoalescingBuffer<string>(40, (_k, items) => {
			flushes.push(items);
		}, 70);
		buf.push("c1", "a");
		await sleep(25);
		buf.push("c1", "b");
		await sleep(25);
		buf.push("c1", "c");
		// Ceiling fires ~70ms after the first push, mid-dribble.
		await sleep(30);
		expect(flushes).toEqual([["a", "b", "c"]]);
		// The post-ceiling dribble starts a fresh bucket on its own timer.
		buf.push("c1", "d");
		await sleep(60);
		expect(flushes).toEqual([
			["a", "b", "c"],
			["d"],
		]);
	});

	test("drain disarms the max-wait timer too", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(40, (_k, items) => {
			flushes.push(items);
		}, 70);
		buf.push("c1", "a");
		await buf.drain();
		expect(flushes).toEqual([["a"]]);
		await sleep(120); // neither timer may re-fire
		expect(flushes).toEqual([["a"]]);
	});

	test("a rejected submit retains the batch and retries it before later arrivals", async () => {
		const flushes: string[][] = [];
		let fail = true;
		const buf = new CoalescingBuffer<string>(40, (_key, items) => {
			if (fail) throw new Error("history write failed");
			flushes.push(items);
		});
		buf.push("c1", "first");
		await expect(buf.drain()).rejects.toThrow("messages retained for retry");
		buf.push("c1", "second");
		fail = false;
		await buf.drain();
		expect(flushes).toEqual([["first", "second"]]);
	});

	test("consecutive failures back the retry off past the constant delay", async () => {
		const flushes: string[][] = [];
		let failuresLeft = 2;
		const buf = new CoalescingBuffer<string>(
			40,
			(_key, items) => {
				if (failuresLeft > 0) {
					failuresLeft--;
					throw new Error("history write failed");
				}
				flushes.push(items);
			},
			70,
		);
		buf.push("c1", "first");
		// Two failures back to back: the pending retry is re-armed at the
		// doubled delay (~2s), not the old constant max(window, 1s) = 1s.
		await expect(buf.drain()).rejects.toThrow("messages retained for retry");
		await expect(buf.drain()).rejects.toThrow("messages retained for retry");
		await sleep(1_200); // past 1s — the constant delay would have fired
		expect(flushes).toEqual([]);
		// The batch is still intact and complete for the next attempt.
		await buf.drain();
		expect(flushes).toEqual([["first"]]);
	}, 10_000);

	test("a rejected async flush retains the batch and the retry re-runs it", async () => {
		const flushes: string[][] = [];
		let fail = true;
		const buf = new CoalescingBuffer<string>(40, async (_key, items) => {
			if (fail) throw new Error("follow-up check unreachable");
			flushes.push(items);
		});
		buf.push("c1", "first");
		await expect(buf.drain()).rejects.toThrow("messages retained for retry");
		buf.push("c1", "second");
		fail = false;
		await buf.drain();
		expect(flushes).toEqual([["first", "second"]]);
	});

	test("a key's next bucket waits for its in-flight async flush", async () => {
		const calls: string[][] = [];
		let overlap = false;
		let inflight = false;
		let release: () => void = () => {};
		const buf = new CoalescingBuffer<string>(30, (_key, items) => {
			if (inflight) overlap = true;
			inflight = true;
			calls.push(items);
			return new Promise<void>((resolve) => {
				release = () => {
					inflight = false;
					resolve();
				};
			});
		});
		buf.push("c1", "first");
		await sleep(50); // quiet window elapsed — flush 1 in flight
		buf.push("c1", "second");
		await sleep(60); // its quiet AND max timers elapsed during flight
		expect(calls).toEqual([["first"]]); // the second batch never fired early
		release();
		await sleep(20); // deferred fire lands right after the settle
		expect(calls).toEqual([["first"], ["second"]]);
		expect(overlap).toBe(false);
		release(); // let flush 2 settle — it was captured by the deferred fire
		await buf.drain();
	});

	test("drain awaits an in-flight async flush and its deferred successor", async () => {
		const flushes: string[][] = [];
		let release: () => void = () => {};
		const buf = new CoalescingBuffer<string>(20, (_key, items) => {
			if (flushes.length === 0) {
				return new Promise<void>((resolve) => {
					release = () => {
						flushes.push(items);
						resolve();
					};
				});
			}
			flushes.push(items);
		});
		buf.push("c1", "first");
		await sleep(40); // flush 1 in flight
		buf.push("c1", "second");
		const drained = buf.drain(); // disarms timers; second fire defers
		await sleep(50);
		release();
		await drained;
		expect(flushes).toEqual([["first"], ["second"]]);
	});
});
