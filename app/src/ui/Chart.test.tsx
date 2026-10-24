import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Chart } from "./Chart.tsx";

function ticks(values: number[]): string[] {
	const html = renderToStaticMarkup(
		<Chart
			leaf={{
				kind: "line",
				x: values.map((_, i) => `x${i}`),
				series: [{ name: "Reading", values }],
			}}
		/>,
	);
	return [...html.matchAll(/<text[^>]*text-anchor="end"[^>]*>(.*?)<\/text>/g)].map((m) => m[1]!);
}

test("small decimal charts show distinct ticks at their spacing", () => {
	expect(ticks([0.01, 0.02])).toEqual(["0", "0.005", "0.01", "0.015", "0.02"]);
	expect(ticks([-0.02, 0.02])).toEqual(["-0.02", "-0.01", "0", "0.01", "0.02"]);
	expect(ticks([1e-9, 2e-9])).toEqual(["0", "5e-10", "1e-9", "1.5e-9", "2e-9"]);
});

test("integer, zero and large charts keep compact readable ticks", () => {
	expect(ticks([1, 4])).toEqual(["0", "1", "2", "3", "4"]);
	expect(ticks([0, 0])).toEqual(["0", "0.25", "0.5", "0.75", "1"]);
	expect(ticks([10_000, 50_000])).toEqual(["0", "12.5k", "25k", "37.5k", "50k"]);
});

function chart(kind: "bar" | "line" | "pie", x: string[], values: number[], unit?: string): string {
	return renderToStaticMarkup(
		<Chart leaf={{ kind, x, series: [{ name: "km", values }], unit }} />,
	);
}

test("a pie renders one arc per slice, labelled by x with share tooltips", () => {
	const html = chart("pie", ["a", "b", "c"], [2, 1, 1], "km");
	expect(html.match(/<path /g)?.length).toBe(3);
	// Slices take x labels + shares — not the series name.
	expect(html).toContain("<title>a: 2 km (50%)</title>");
	expect(html).toContain("<title>b: 1 km (25%)</title>");
	expect(html).toContain("a · 50%");
	expect(html).not.toContain("km ·"); // legend is not the series legend
});

test("a pie's displayed shares always sum to 100", () => {
	// Thirds render 33.33… per slice — per-slice Math.round would show
	// 99 total; largest remainder bumps the first to 34.
	const html = chart("pie", ["a", "b", "c"], [1, 1, 1]);
	const shares = [...html.matchAll(/· (\d+)%/g)].map((m) => Number(m[1]));
	expect(shares).toHaveLength(3);
	expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
	expect(html).toContain("a · 34%");
});

test("a single full-share slice renders a circle — a coincident arc draws nothing", () => {
	const html = chart("pie", ["everything"], [42], "km");
	// SVG arcs with identical endpoints render as zero-length — the
	// only visible 100% slice is a whole circle.
	expect(html).toContain("<circle");
	expect(html).toContain("everything · 100%");
	expect(html).toContain("<title>everything: 42 km (100%)</title>");
});

test("a zero-total pie degrades to 0% arcs, never NaN", () => {
	const html = chart("pie", ["a", "b"], [0, 0]);
	expect(html.match(/<path /g)?.length).toBe(2);
	expect(html).not.toContain("NaN");
	expect(html).toContain("(0%)");
});

test("bar and line marks carry native series·x tooltips", () => {
	expect(chart("bar", ["Mon"], [12], "km")).toContain("<title>km · Mon: 12 km</title>");
	expect(chart("line", ["Mon"], [12])).toContain("<title>km · Mon: 12</title>");
});
