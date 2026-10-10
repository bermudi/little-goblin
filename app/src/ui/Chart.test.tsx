import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Chart } from "./Chart.tsx";

function ticks(values: number[]): string[] {
	const html = renderToStaticMarkup(
		<Chart
			leaf={{
				type: "chart",
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
