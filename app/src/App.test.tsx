import { describe, expect, test } from "bun:test";
import { flatLine } from "./App.tsx";

// Stored titles predate store-side flattening — the sidebar row must
// render them clean regardless of the server's vintage.

describe("flatLine", () => {
	test("a fenced title loses the fence and language tag", () => {
		expect(
			flatLine('```typescript const slug = (s: string): string => s.trim(); ```'),
		).toBe("const slug = (s: string): string => s.trim();");
	});

	test("inline backticks, links, and emphasis flatten", () => {
		expect(flatLine("run `bun test` then see [docs](https://a.dev) — **bold**")).toBe(
			"run bun test then see docs — bold",
		);
	});

	test("line-lead markers and whitespace collapse", () => {
		expect(flatLine("## multi\n   line   title")).toBe("multi line title");
	});

	test("a title reduced to markdown furniture empties out", () => {
		expect(flatLine("``` ```")).toBe("");
	});
});
