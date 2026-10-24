// The flat element-map's structural rules — every one a superRefine
// issue naming the offending ids. The schema itself only knows per-
// element shape; the tree's integrity (exists, hangs together, respects
// container membership) is what these tests pin.

import { describe, expect, test } from "bun:test";
import { uiElementSchema, uiInputSchema } from "./ui-schema.ts";

const text = (md = "x") => ({ type: "text", props: { md } });
const tab = (label: string, children: string[]) => ({
	type: "tab",
	props: { label },
	children,
});
const column = (children: string[]) => ({ type: "column", children });

const issues = (input: unknown): string[] => {
	const r = uiInputSchema.safeParse(input);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("structural rules", () => {
	test("a minimal root text is valid", () => {
		expect(uiInputSchema.safeParse({ root: "a", elements: { a: text() } }).success).toBe(true);
	});

	test("five-plus-deep nesting validates — depth is unbounded", () => {
		const deep = {
			root: "s",
			elements: {
				s: { type: "stack", children: ["t"] },
				t: { type: "tabs", children: ["ta", "tb"] },
				ta: tab("a", ["c"]),
				tb: tab("b", ["x"]),
				c: { type: "columns", children: ["c1", "c2"] },
				c1: column(["st"]),
				c2: column(["x2"]),
				st: { type: "steps", props: { items: [{ title: "one" }] } },
				x: text(),
				x2: text(),
			},
		};
		const r = uiInputSchema.safeParse(deep);
		expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
	});

	test("a child id that names no element is rejected", () => {
		const bad = {
			root: "s",
			elements: { s: { type: "stack", children: ["a", "ghost"] }, a: text() },
		};
		const msgs = issues(bad);
		expect(msgs.some((m) => m.includes('"ghost"'))).toBe(true);
	});

	test("a root that names no element is rejected", () => {
		const msgs = issues({ root: "missing", elements: { a: text() } });
		expect(msgs.some((m) => m.includes('root "missing"'))).toBe(true);
	});

	test("a prototype-named root is rejected — existence is own-key", () => {
		const msgs = issues({ root: "toString", elements: { a: text() } });
		expect(msgs.some((m) => m.includes('root "toString"'))).toBe(true);
	});

	test("a prototype-named child is rejected — existence is own-key", () => {
		const bad = {
			root: "s",
			elements: { s: { type: "stack", children: ["hasOwnProperty"] } },
		};
		const msgs = issues(bad);
		expect(msgs.some((m) => m.includes('child "hasOwnProperty"'))).toBe(true);
	});

	test('elements literally named "root" and "elements" work as normal ids', () => {
		const ok = {
			root: "elements",
			elements: {
				elements: { type: "stack", children: ["root"] },
				root: text(),
			},
		};
		const r = uiInputSchema.safeParse(ok);
		expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
	});

	test("a cycle is rejected", () => {
		const bad = {
			root: "a",
			elements: {
				a: { type: "stack", children: ["b"] },
				b: { type: "stack", children: ["a"] },
			},
		};
		const msgs = issues(bad);
		expect(msgs.some((m) => m.includes("cycle"))).toBe(true);
	});

	test("an element with two parents is rejected", () => {
		const bad = {
			root: "s",
			elements: {
				s: { type: "stack", children: ["a", "b"] },
				a: { type: "stack", children: ["leaf"] },
				b: { type: "stack", children: ["leaf"] },
				leaf: text(),
			},
		};
		const msgs = issues(bad);
		expect(msgs.some((m) => m.includes("two parents"))).toBe(true);
	});

	test("a duplicated child under the same parent names it a duplicate", () => {
		const bad = {
			root: "s",
			elements: { s: { type: "stack", children: ["a", "a"] }, a: text() },
		};
		const msgs = issues(bad);
		expect(msgs.some((m) => m.includes('duplicate child of "s"'))).toBe(true);
	});

	test("a tabs child that is not a tab is rejected", () => {
		const bad = {
			root: "t",
			elements: { t: { type: "tabs", children: ["a", "x"] }, a: tab("a", ["l"]), x: text(), l: text() },
		};
		expect(issues(bad).some((m) => m.includes('child "x" is type "text"'))).toBe(true);
	});

	test("a tab outside tabs is rejected", () => {
		const bad = {
			root: "s",
			elements: { s: { type: "stack", children: ["a"] }, a: tab("a", ["l"]), l: text() },
		};
		expect(issues(bad).some((m) => m.includes('tab "a" is not inside a tabs element'))).toBe(true);
	});

	test("a column outside columns is rejected", () => {
		const bad = {
			root: "s",
			elements: { s: { type: "stack", children: ["c"] }, c: column(["l"]), l: text() },
		};
		expect(issues(bad).some((m) => m.includes('column "c" is not inside a columns element'))).toBe(
			true,
		);
	});

	test("tabs with one child is rejected by the children bound", () => {
		const bad = {
			root: "t",
			elements: { t: { type: "tabs", children: ["a"] }, a: tab("a", ["l"]), l: text() },
		};
		expect(uiInputSchema.safeParse(bad).success).toBe(false);
	});

	test("columns with five children is rejected by the children bound", () => {
		const bad = {
			root: "c",
			elements: {
				c: { type: "columns", children: ["1", "2", "3", "4", "5"] },
				"1": column(["l"]),
				"2": column(["l2"]),
				"3": column(["l3"]),
				"4": column(["l4"]),
				"5": column(["l5"]),
				l: text(),
				l2: text(),
				l3: text(),
				l4: text(),
				l5: text(),
			},
		};
		expect(uiInputSchema.safeParse(bad).success).toBe(false);
	});

	test("a leaf with children is rejected", () => {
		const bad = {
			root: "s",
			elements: {
				s: { type: "stack", children: ["a"] },
				a: { ...text(), children: ["l"] },
				l: text(),
			},
		};
		expect(issues(bad).some((m) => m.includes('leaf "a" (text) must not have children'))).toBe(
			true,
		);
	});

	test("over 200 elements is rejected", () => {
		const elements: Record<string, unknown> = { root: { type: "stack", children: ["0"] } };
		for (let i = 0; i < 201; i++) elements[String(i)] = text();
		expect(uiInputSchema.safeParse({ root: "root", elements }).success).toBe(false);
	});
});

describe("element-level validation", () => {
	test("per-element schema accepts a leaf and a container", () => {
		expect(uiElementSchema.safeParse({ type: "text", props: { md: "x" } }).success).toBe(true);
		expect(uiElementSchema.safeParse({ type: "stack", children: ["a"] }).success).toBe(true);
	});

	test("a bare {type} element is invalid (a streaming skeleton, not content)", () => {
		expect(uiElementSchema.safeParse({ type: "text" }).success).toBe(false);
		expect(uiElementSchema.safeParse({ type: "tabs" }).success).toBe(false);
	});

	test("an unknown type is rejected", () => {
		expect(uiElementSchema.safeParse({ type: "carousel", props: {} }).success).toBe(false);
	});

	test("leaf prop rules hold inside elements", () => {
		expect(
			uiElementSchema.safeParse({
				type: "chart",
				props: { kind: "pie", x: ["a", "b"], series: [{ name: "s", values: [3, -1] }] },
			}).success,
		).toBe(false);
		expect(
			uiElementSchema.safeParse({
				type: "form",
				props: {
					fields: [
						{ name: "amount", label: "Amount", kind: "number" },
						{ name: "amount", label: "Note", kind: "text" },
					],
					submit: "Send",
				},
			}).success,
		).toBe(false);
		expect(
			uiElementSchema.safeParse({
				type: "form",
				props: { fields: [{ name: "t", label: "T", kind: "select" }], submit: "go" },
			}).success,
		).toBe(false);
	});
});
