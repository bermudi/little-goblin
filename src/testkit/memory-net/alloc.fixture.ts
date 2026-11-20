import { describe, expect, test } from "bun:test";

describe("runaway", () => {
	test("a calm test passes first", () => {
		expect(true).toBe(true);
	});

	test("allocates forever in synchronous code", () => {
		const buffers: Uint8Array[] = [];
		const deadline = Date.now() + 30_000;
		while (process.memoryUsage.rss() < 1024 ** 3 && Date.now() < deadline) {
			const buffer = new Uint8Array(1024 ** 2);
			buffer.fill(1);
			buffers.push(buffer);
		}
		while (Date.now() < deadline) {
			// Keep the JS thread busy until the external watchdog has time to trip.
		}
		throw new Error("memory net did not fire");
	});
});
