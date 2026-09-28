import { describe, expect, test } from "bun:test";
import { CoalescingBuffer } from "./buffer.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coalescing buffer", () => {
	test("rapid pushes merge into one flush", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(40, (_k, items) => flushes.push(items));
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
		const buf = new CoalescingBuffer<string>(40, (_k, items) => flushes.push(items));
		buf.push("c1", "a");
		buf.push("c2", "x");
		buf.drain();
		expect(flushes).toEqual([["a"], ["x"]]);
		await sleep(80); // disarmed timers must not re-fire
		expect(flushes).toEqual([["a"], ["x"]]);
	});

	test("a quiet gap starts a new batch", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(30, (_k, items) => flushes.push(items));
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
		const buf = new CoalescingBuffer<string>(40, (_k, items) => flushes.push(items), 70);
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
		const buf = new CoalescingBuffer<string>(40, (_k, items) => flushes.push(items), 70);
		buf.push("c1", "a");
		buf.drain();
		expect(flushes).toEqual([["a"]]);
		await sleep(120); // neither timer may re-fire
		expect(flushes).toEqual([["a"]]);
	});

	test("a rejected submit retains the batch and retries it before later arrivals", () => {
		const flushes: string[][] = [];
		let fail = true;
		const buf = new CoalescingBuffer<string>(40, (_key, items) => {
			if (fail) throw new Error("history write failed");
			flushes.push(items);
		});
		buf.push("c1", "first");
		expect(() => buf.drain()).toThrow("messages retained for retry");
		buf.push("c1", "second");
		fail = false;
		buf.drain();
		expect(flushes).toEqual([["first", "second"]]);
	});
});
