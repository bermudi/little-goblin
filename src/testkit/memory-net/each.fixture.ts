import { describe, expect, test } from "bun:test";

describe("outer", () => {
	describe("inner", () => {
		test.each([[1], [2]] as const)("case %i", (value) => {
			if (value === 1) {
				expect(value).toBe(1);
				return;
			}

			const buffers: Uint8Array[] = [];
			while (process.memoryUsage.rss() < 1024 ** 3) {
				const buffer = new Uint8Array(1024 ** 2);
				buffer.fill(1);
				buffers.push(buffer);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
			throw new Error("memory net did not fire");
		});
	});
});
