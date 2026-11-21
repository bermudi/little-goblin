import { describe, expect, test } from "bun:test";

// Concise arrows make each registration a tail call: JavaScriptCore drops the
// caller's frame, so the net cannot read this file's line from the stack.
function row(value: number): void {
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
}

describe("outer", () => describe("inner", () => test.each([[1], [2]])("case %i", row)));
