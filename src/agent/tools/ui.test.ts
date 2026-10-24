// The ui tool's boundary tests: the flat element-map schema is the
// contract the model writes against, and its JSON Schema is what the
// provider receives — a shape the provider rejects would break every
// app turn (no $ref/$defs/propertyNames). normalizeUiInput's rules each
// fire only when exactly one interpretation exists.

import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTools } from "./mod.ts";
import { uiTool } from "./ui.ts";
import { normalizeUiInput, uiInputSchema } from "./ui-schema.ts";

const testdata = (name: string): unknown =>
	JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "testdata", name), "utf8"));

const fixture = testdata("ui-all-elements.json");

describe("uiInputSchema", () => {
	test("accepts the every-element fixture", () => {
		const parsed = uiInputSchema.safeParse(fixture);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	test("a legacy {blocks} input is not converted — it fails validation", () => {
		// Operator call: old conversations keep their parts and render as
		// the generic tool row; nothing is migrated.
		const legacy = { title: "x", blocks: [{ type: "text", md: "hi" }] };
		const r = normalizeUiInput(legacy);
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});
});

describe("wire JSON schema", () => {
	test("the tool schema carries no $ref/$defs/propertyNames", () => {
		const wire = JSON.stringify(asSchema(uiTool().inputSchema).jsonSchema);
		for (const banned of ['"$ref"', '"$defs"', '"propertyNames"']) {
			expect(wire).not.toContain(banned);
		}
	});

	test("property order is title, root, elements — root streams first", () => {
		const schema = asSchema(uiTool().inputSchema).jsonSchema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties)).toEqual(["title", "root", "elements"]);
	});
});

describe("normalizeUiInput", () => {
	test("rule 1: elements as a JSON string parses into place", () => {
		const r = normalizeUiInput({
			root: "a",
			elements: '{"a":{"type":"text","props":{"md":"hi"}}}',
		});
		expect(r.report.parsedProps).toEqual(["elements"]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(true);
	});

	test("rule 1b: a stringified props object parses into place", () => {
		const r = normalizeUiInput({
			root: "a",
			elements: { a: { type: "text", props: '{"md":"hi"}' } },
		});
		expect(r.report.parsedProps).toEqual(["a"]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(true);
	});

	test("rule 1 negative: a non-object JSON string stays", () => {
		const r = normalizeUiInput({
			root: "a",
			elements: { a: { type: "text", props: '"just a string"' } },
		});
		expect(r.report.parsedProps).toEqual([]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});

	test("rule 2: content fields on the element top level hoist into props", () => {
		const r = normalizeUiInput({
			root: "a",
			elements: { a: { type: "callout", tone: "warn", title: "t", md: "m" } },
		});
		expect(r.report.hoisted).toEqual([{ id: "a", keys: ["tone", "title", "md"] }]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(true);
	});

	test("rule 2 negative: extra keys stay when props already exists", () => {
		const r = normalizeUiInput({
			root: "a",
			elements: { a: { type: "text", props: { md: "hi" }, stray: 1 } },
		});
		expect(r.report.hoisted).toEqual([]);
	});

	test("rule 3: a typeless element re-types by props key-set", () => {
		const r = normalizeUiInput({
			elements: {
				a: { type: "stack", children: ["c", "p"] },
				c: { props: { md: "hi", title: "t" } },
				p: { props: { options: ["bare", "strings"], prompt: "pick" } },
			},
		});
		expect(r.report.inferred).toEqual([
			{ id: "c", type: "callout" },
			{ id: "p", type: "choices" },
		]);
		const parsed = uiInputSchema.safeParse(r.value);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
		// Bare string options became {label} objects.
		if (parsed.success) {
			const p = parsed.data.elements.p;
			expect(p?.type).toBe("choices");
			if (p?.type === "choices") expect(p.props.options[0]).toEqual({ label: "bare" });
		}
	});

	test("rule 3: {label} alone infers tab — the one inferable container", () => {
		const r = normalizeUiInput({
			elements: {
				t: { type: "tabs", children: ["a", "b"] },
				a: { props: { label: "one" }, children: ["l1"] },
				b: { props: { label: "two" }, children: ["l2"] },
				l1: { type: "text", props: { md: "x" } },
				l2: { type: "text", props: { md: "y" } },
			},
		});
		expect(r.report.inferred).toEqual([
			{ id: "a", type: "tab" },
			{ id: "b", type: "tab" },
		]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(true);
	});

	test("rule 3 negative: an ambiguous props key-set is no repair", () => {
		// {items: [...]} fits both stats and steps when the items satisfy
		// both shapes — a tie is not a repair.
		const r = normalizeUiInput({
			elements: {
				a: { props: { items: [{ label: "l", value: "1", title: "t" }] } },
			},
		});
		expect(r.report.inferred).toEqual([]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});

	test("rule 3 negative: an unmatchable object stays invalid", () => {
		const r = normalizeUiInput({ elements: { a: { props: { frobnicate: true } } } });
		expect(r.report.inferred).toEqual([]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});

	test("rule 4: inline child objects hoist into the map, recursively", () => {
		const r = normalizeUiInput({
			root: "s",
			elements: {
				s: {
					type: "stack",
					children: [
						"a",
						{
							type: "stack",
							children: [
								{ type: "text", props: { md: "x" } },
								{ type: "text", props: { md: "y" } },
							],
						},
					],
				},
				a: { type: "text", props: { md: "leaf" } },
				"s.1": { type: "stack", children: ["a"] }, // forces a ~2 suffix
			},
		});
		expect(r.report.flattened).toEqual([
			{ id: "s.1~2", parent: "s" },
			{ id: "s.1~2.0", parent: "s.1~2" },
			{ id: "s.1~2.1", parent: "s.1~2" },
		]);
		const parsed = uiInputSchema.safeParse(r.value);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	test("rule 5: an array root becomes a synthesized stack", () => {
		const r = normalizeUiInput({
			root: ["a", "b"],
			elements: { a: { type: "text", props: { md: "x" } }, b: { type: "text", props: { md: "y" } } },
		});
		expect(r.report.synthesizedRoot).toBe("root");
		const parsed = uiInputSchema.safeParse(r.value);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	test("rule 6: a missing root picks the single unreferenced element", () => {
		const r = normalizeUiInput({
			elements: {
				s: { type: "stack", children: ["a"] },
				a: { type: "text", props: { md: "x" } },
			},
		});
		expect(r.report.inferredRoot).toBe("s");
		expect(uiInputSchema.safeParse(r.value).success).toBe(true);
	});

	test("rule 6 negative: two orphans mean no guess", () => {
		const r = normalizeUiInput({
			elements: { a: { type: "text", props: { md: "x" } }, b: { type: "text", props: { md: "y" } } },
		});
		expect(r.report.inferredRoot).toBeNull();
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});

	test("rule 7: numeric-string chart values coerce; formatted ones stay", () => {
		const r = normalizeUiInput({
			root: "c",
			elements: {
				c: {
					type: "chart",
					props: {
						kind: "bar",
						x: ["a", "b", "c"],
						series: [{ name: "s", values: ["1", "2.5", "$6.00"] }],
					},
				},
			},
		});
		expect(r.report.coerced).toEqual([{ id: "c", count: 2 }]);
		// "$6.00" stays a string → the chart still fails validation.
		expect(uiInputSchema.safeParse(r.value).success).toBe(false);
	});

	test("rule 7 via inference: a typeless chart with string values re-types", () => {
		const r = normalizeUiInput({
			elements: {
				c: { props: { kind: "pie", x: ["a", "b"], series: [{ name: "s", values: ["3", "4"] }] } },
			},
		});
		expect(r.report.inferred).toEqual([{ id: "c", type: "chart" }]);
		const parsed = uiInputSchema.safeParse(r.value);
		expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	test("rule 8: prune drops elements unreachable from root", () => {
		const r = normalizeUiInput({
			root: "s",
			elements: {
				s: { type: "stack", children: ["a"] },
				a: { type: "text", props: { md: "x" } },
				stray: { type: "text", props: { md: "unreachable" } },
			},
		});
		expect(r.report.unreachable).toEqual(["stray"]);
		expect(uiInputSchema.safeParse(r.value).success).toBe(true);
	});

	test("rule 8: prune:false keeps unreachable elements", () => {
		const r = normalizeUiInput(
			{
				root: "s",
				elements: {
					s: { type: "stack", children: ["a"] },
					a: { type: "text", props: { md: "x" } },
					stray: { type: "text", props: { md: "unreachable" } },
				},
			},
			{ prune: false },
		);
		expect(r.report.unreachable).toEqual([]);
		const els = (r.value as { elements: Record<string, unknown> }).elements;
		expect(Object.keys(els)).toContain("stray");
	});

	test("never mutates the input", () => {
		const raw = { elements: { a: { md: "hi" } } };
		normalizeUiInput(raw);
		expect(raw).toEqual({ elements: { a: { md: "hi" } } });
	});
});

describe("makeTools ui gate", () => {
	test("ui mounts only on the explicit flag", () => {
		expect(makeTools({ cwd: "/tmp", ui: true })).toHaveProperty("ui");
		expect(makeTools({ cwd: "/tmp" })).not.toHaveProperty("ui");
	});
});
