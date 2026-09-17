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

	test("a quiet gap starts a new batch", async () => {
		const flushes: string[][] = [];
		const buf = new CoalescingBuffer<string>(30, (_k, items) => flushes.push(items));
		buf.push("c1", "first");
		await sleep(60);
		buf.push("c1", "second");
		await sleep(60);
		expect(flushes).toEqual([["first"], ["second"]]);
	});
});
