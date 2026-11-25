import { expect, test } from "bun:test";
import { liveElapsed, openLive } from "./stream.ts";

test("each live turn captures its own start once", () => {
	const first = openLive(1000);
	const second = openLive(2000);
	expect(liveElapsed(first, 29_000)).toBe(28_000);
	expect(liveElapsed(second, 29_000)).toBe(27_000);
	expect(liveElapsed(second, 1500)).toBe(0);
});
