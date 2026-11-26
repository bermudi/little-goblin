import { describe, expect, test } from "bun:test";
import { quoteButtonPosition } from "./QuoteFab.tsx";

const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
	({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const viewport = { width: 800, height: 600 };
const bounds = rect(0, 0, 700, 550);
const position = (lineRects: DOMRect[], pointer: { x: number; y: number } | null = null, box = bounds) =>
	quoteButtonPosition({ lineRects, pointer, viewport, bounds: box });

describe("quoteButtonPosition", () => {
	test("places a one-line selection below the line", () => {
		const line = rect(100, 100, 220, 120);
		expect(position([line])).toEqual({ x: 220, y: 126 });
	});

	test("follows a pointer over the line and uses the line end when it is off the selection", () => {
		const line = rect(100, 100, 220, 120);
		expect(position([line], { x: 150, y: 110 })?.x).toBe(150);
		expect(position([line], { x: 150, y: 500 })?.x).toBe(220);
		expect(position([line], { x: 300, y: 110 })?.x).toBe(220);
	});

	test("null pointer places the button below the last line", () => {
		expect(position([rect(100, 100, 220, 120)])).toEqual({ x: 220, y: 126 });
	});

	test("moves above a selection when bottom clamping would overlap it", () => {
		expect(position([rect(100, 460, 220, 480)], null, rect(0, 0, 700, 500))).toEqual({ x: 220, y: 422 });
	});

	test("clamps the button inside the right edge", () => {
		expect(position([rect(40, 100, 90, 120)], null, rect(0, 0, 100, 200))?.x).toBe(20);
	});
});
