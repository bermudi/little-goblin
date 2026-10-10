// The ui tool's boundary tests: the schema is the contract the model
// writes against, and its JSON Schema is what the provider receives —
// a shape the provider rejects would break every app turn
// (design/app.md → Intelligent UI: two levels, no $ref/$defs).

import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTools } from "./mod.ts";
import { uiTool } from "./ui.ts";
import { normalizeUiInput, uiBlockSchema, uiInputSchema } from "./ui-schema.ts";

const testdata = (name: string): unknown =>
	JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "testdata", name), "utf8"));

const fixture = testdata("ui-all-blocks.json");

describe("uiInputSchema", () => {
	test("accepts the every-block fixture", () => {
		const parsed = uiInputSchema.safeParse(fixture);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	test("rejects a container nested inside a container", () => {
		const nested = {
			title: "x",
			blocks: [
				{
					type: "tabs",
					tabs: [
						{
							label: "a",
							blocks: [
								{
									type: "columns",
									columns: [
										{ blocks: [{ type: "text", md: "deep" }] },
										{ blocks: [{ type: "text", md: "deeper" }] },
									],
								},
							],
						},
						{ label: "b", blocks: [{ type: "text", md: "ok" }] },
					],
				},
			],
		};
		expect(uiInputSchema.safeParse(nested).success).toBe(false);
	});

	test("rejects an unknown block type", () => {
		expect(uiBlockSchema.safeParse({ type: "carousel", items: [] }).success).toBe(false);
	});

	test("rejects a chart whose series length differs from x", () => {
		const bad = {
			type: "chart",
			kind: "bar",
			x: ["a", "b", "c"],
			series: [{ name: "s", values: [1, 2] }],
		};
		expect(uiBlockSchema.safeParse(bad).success).toBe(false);
	});

	test("rejects a select field without options", () => {
		const bad = {
			type: "form",
			fields: [{ name: "t", label: "T", kind: "select" }],
			submit: "go",
		};
		expect(uiBlockSchema.safeParse(bad).success).toBe(false);
		expect(
			uiBlockSchema.safeParse({
				type: "form",
				fields: [{ name: "t", label: "T", kind: "select", options: ["x", "y"] }],
				submit: "go",
			}).success,
		).toBe(true);
	});

	test("the wire JSON Schema carries no $ref/$defs", () => {
		// asSchema is the SDK's own zod→JSON-Schema path — what streamText
		// actually sends the provider (ai v7 re-exports it from
		// @ai-sdk/provider-utils).
		const wire = JSON.stringify(asSchema(uiInputSchema).jsonSchema);
		expect(wire).not.toContain('"$ref"');
		expect(wire).not.toContain('"$defs"');
	});
});

describe("normalizeUiInput", () => {
	test("repairs the verbatim typeless probe payloads", () => {
		const bike2 = testdata("ui-typeless-bike2.json");
		const r2 = normalizeUiInput(bike2);
		expect(r2.dropped).toBe(0);
		expect(r2.inferred).toEqual([
			{ path: "blocks.1", type: "chart" },
			{ path: "blocks.3", type: "choices" },
		]);
		const p2 = uiInputSchema.safeParse(r2.value);
		expect(p2.success, p2.success ? "" : JSON.stringify(p2.error.issues)).toBe(true);

		const bike3 = testdata("ui-typeless-bike3.json");
		const r3 = normalizeUiInput(bike3);
		// blocks.2 re-typed as choices; the bare {"type":"choices"}
		// fragment at blocks.3 drops.
		expect(r3.inferred).toEqual([{ path: "blocks.2", type: "choices" }]);
		expect(r3.dropped).toBe(1);
		const p3 = uiInputSchema.safeParse(r3.value);
		expect(p3.success, p3.success ? "" : JSON.stringify(p3.error.issues)).toBe(true);
		// Bare string options became {label} objects.
		const choices = (p3.success ? p3.data.blocks : []).find((b) => b.type === "choices");
		expect(choices?.type).toBe("choices");
		if (choices?.type === "choices") {
			expect(choices.options[0]).toEqual({ label: "Long and fast on smooth pavement" });
		}
	});

	test("tiebreaks: {md} is text, {md,title} is callout", () => {
		const a = normalizeUiInput({ blocks: [{ md: "hi" }] });
		expect(a.inferred).toEqual([{ path: "blocks.0", type: "text" }]);
		const b = normalizeUiInput({ blocks: [{ md: "hi", title: "t" }] });
		expect(b.inferred).toEqual([{ path: "blocks.0", type: "callout" }]);
	});

	test("an unmatchable object stays invalid", () => {
		const r = normalizeUiInput({ blocks: [{ frobnicate: true }] });
		expect(r.inferred).toEqual([]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});

	test("a bare {type} is dropped, inside containers too", () => {
		const r = normalizeUiInput({
			blocks: [
				{ type: "text", md: "keep" },
				{ type: "text" },
				{
					type: "tabs",
					tabs: [
						{ label: "a", blocks: [{ type: "callout" }, { type: "text", md: "ok" }] },
						{ label: "b", blocks: [{ type: "text", md: "ok2" }] },
					],
				},
			],
		});
		expect(r.dropped).toBe(2);
		const parsed = uiInputSchema.safeParse(r.value);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	test("never mutates the input", () => {
		const raw = { blocks: [{ md: "hi" }] };
		normalizeUiInput(raw);
		expect(raw).toEqual({ blocks: [{ md: "hi" }] });
	});
});

describe("ui tool wire schema", () => {
	test("deep-equals the zod conversion and stays $ref-free", () => {
		const zod = asSchema(uiInputSchema).jsonSchema;
		const wire = asSchema(uiTool().inputSchema).jsonSchema;
		expect(wire).toEqual(zod);
		const s = JSON.stringify(wire);
		expect(s).not.toContain('"$ref"');
		expect(s).not.toContain('"$defs"');
	});
});

describe("makeTools ui gate", () => {
	test("ui mounts only on the explicit flag", () => {
		expect(makeTools({ cwd: "/tmp", ui: true })).toHaveProperty("ui");
		expect(makeTools({ cwd: "/tmp" })).not.toHaveProperty("ui");
	});
});
