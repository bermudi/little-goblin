// The ui tool's input schema — json-render's flat element-map SHAPE
// (shape only: no $state/actions runtime, no inline-patch protocol).
// "root" names the top element; "elements" maps each id to
// {type, props, children} where children lists child ids — so nesting
// depth is unbounded without a recursive schema (no $ref/$defs, which
// providers handle unevenly). Structural rules — the tree must exist,
// hold together, and respect container membership — live in the
// superRefine; leaf props are the same fields and limits as ever.

import { z } from "zod";

const md = () => z.string().describe("Markdown body");

const children = (min: number, max: number) =>
	z
		.array(z.string())
		.min(min)
		.max(max)
		.describe(`Child element ids, ${min}–${max} — ids into the elements map, never nested objects`);

// ---------- leaf props (same fields/limits as the two-level schema) ----------

const textProps = z.object({
	md: md().describe("Markdown text — prose inside the interface"),
});

const calloutProps = z.object({
	tone: z
		.enum(["info", "warn", "success", "danger"])
		.optional()
		.describe("Emphasis tone; defaults to info"),
	title: z.string().optional().describe("Short callout heading"),
	md: md().describe("Markdown body of the callout"),
});

const statsProps = z.object({
	items: z
		.array(
			z.object({
				label: z.string().describe("What the number measures"),
				value: z.string().describe('The headline figure, e.g. "42 km/h"'),
				note: z.string().optional().describe("Small qualifier under the value"),
			}),
		)
		.min(1)
		.max(8)
		.describe("1–8 headline numbers"),
});

const tableProps = z.object({
	columns: z.array(z.string()).min(1).max(8).describe("Column headers, 1–8"),
	rows: z.array(z.array(z.string())).max(50).describe("Body rows; each row is one cell per column"),
});

const stepsProps = z.object({
	items: z
		.array(
			z.object({
				title: z.string().describe("Step name"),
				md: md().optional().describe("Optional Markdown detail under the step"),
			}),
		)
		.min(1)
		.max(20)
		.describe("Ordered steps, 1–20"),
});

const chartProps = z
	.object({
		kind: z
			.enum(["bar", "line", "pie"])
			.describe(
				"Grouped bars, lines, or a pie — a pie's slices come from the first series, labelled by x (extra series are ignored)",
			),
		x: z.array(z.string()).min(1).max(50).describe("X-axis category labels"),
		series: z
			.array(
				z.object({
					name: z.string().describe("Series label for the legend"),
					values: z.array(z.number()).describe("One value per x label"),
				}),
			)
			.min(1)
			.max(5)
			.describe("1–5 series"),
		unit: z.string().optional().describe('Value unit shown on the axis, e.g. "km"'),
	})
	.refine((c) => c.series.every((s) => s.values.length === c.x.length), {
		message: "every series must have exactly one value per x label",
	})
	.refine((c) => c.kind !== "pie" || c.series[0]!.values.every((v) => v >= 0), {
		message: "pie slices need non-negative values",
	});

const choicesProps = z.object({
	prompt: z.string().optional().describe("Question the options answer"),
	options: z
		.array(z.object({ label: z.string().max(80).describe("Button label") }))
		.min(2)
		.max(8)
		.describe("2–8 tappable options; a tap sends [ui] <label> as a message"),
});

const formProps = z
	.object({
		fields: z
			.array(
				z.object({
					name: z.string().describe("Unique field key sent back on submit"),
					label: z.string().describe("Visible field label"),
					kind: z
						.enum(["text", "number", "select", "checkbox", "textarea", "date"])
						.describe(
							"Input kind. checkbox submits true/false; textarea is multi-line text; date submits YYYY-MM-DD",
						),
					options: z.array(z.string()).optional().describe("Required for kind=select"),
				}),
			)
			.min(1)
			.max(8)
			.describe("1–8 fields"),
		submit: z.string().max(40).describe("Submit button label"),
	})
	.refine((f) => f.fields.every((x) => x.kind !== "select" || (x.options?.length ?? 0) > 0), {
		message: "kind=select fields need a non-empty options list",
	})
	.refine((f) => new Set(f.fields.map((field) => field.name)).size === f.fields.length, {
		message: "form field names must be unique",
		path: ["fields"],
	});

const htmlProps = z.object({
	title: z.string().describe("Accessible frame title"),
	html: z
		.string()
		.max(100_000)
		.describe(
			"Self-contained document body — inline script/style only, no network, no external assets. Rendered sandboxed.",
		),
});

// ---------- elements ----------

const leaf = <T extends string, P extends z.ZodType>(type: T, props: P) =>
	z.object({ type: z.literal(type), props, children: z.array(z.string()).optional() });

const container = <T extends string, P extends z.ZodType>(type: T, props: P, min: number, max: number) =>
	z.object({ type: z.literal(type), props: props.optional(), children: children(min, max) });

const leafElements = z.discriminatedUnion("type", [
	leaf("text", textProps),
	leaf("callout", calloutProps),
	leaf("stats", statsProps),
	leaf("table", tableProps),
	leaf("steps", stepsProps),
	leaf("chart", chartProps),
	leaf("choices", choicesProps),
	leaf("form", formProps),
	leaf("html", htmlProps),
]);

const containerElements = z.discriminatedUnion("type", [
	container("stack", z.object({}), 1, 30),
	container("tabs", z.object({}), 2, 8),
	z.object({
		type: z.literal("tab"),
		props: z.object({ label: z.string().describe("Tab label") }),
		children: children(1, 30),
	}),
	container("columns", z.object({}), 2, 4),
	z.object({
		type: z.literal("column"),
		props: z.object({ title: z.string().optional().describe("Column heading") }).optional(),
		children: children(1, 30),
	}),
]);

export const uiLeafElementSchema = leafElements;
export const uiElementSchema = z.discriminatedUnion("type", [
	...leafElements.options,
	...containerElements.options,
]);

const leafTypes = new Set([
	"text",
	"callout",
	"stats",
	"table",
	"steps",
	"chart",
	"choices",
	"form",
	"html",
]);

export const uiInputSchema = z
	.object({
		title: z.string().optional().describe("Short heading above the interface"),
		root: z.string().describe("Id of the top element in the map"),
		elements: z
			.record(z.string(), uiElementSchema)
			.describe(
				"Flat map of every element: id → {type, props, children}. children lists child ids — never nested objects",
			),
	})
	.superRefine((input, ctx) => {
		const els = input.elements;
		const ids = Object.keys(els);
		if (ids.length > 200) {
			ctx.addIssue({
				code: "custom",
				path: ["elements"],
				message: `too many elements (${ids.length}) — 200 max`,
			});
		}
		if (!(input.root in els)) {
			ctx.addIssue({
				code: "custom",
				path: ["root"],
				message: `root "${input.root}" does not name an element`,
			});
		}
		// Child existence + single parent (the map is a tree, not a DAG).
		const parentOf = new Map<string, string>();
		for (const [pid, el] of Object.entries(els)) {
			for (const c of el.children ?? []) {
				if (!(c in els)) {
					ctx.addIssue({
						code: "custom",
						path: ["elements", pid, "children"],
						message: `child "${c}" does not name an element`,
					});
					continue;
				}
				const prev = parentOf.get(c);
				if (prev !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["elements", pid, "children"],
						message: `element "${c}" has two parents ("${prev}" and "${pid}") — the elements form a tree`,
					});
				} else {
					parentOf.set(c, pid);
				}
			}
		}
		// Container membership rules + leaf childlessness.
		for (const [pid, el] of Object.entries(els)) {
			const kids = el.children ?? [];
			if (el.type === "tabs") {
				for (const c of kids) {
					const t = els[c];
					if (t !== undefined && t.type !== "tab") {
						ctx.addIssue({
							code: "custom",
							path: ["elements", pid],
							message: `tabs "${pid}" child "${c}" is type "${t.type}" — tabs children must be tab elements`,
						});
					}
				}
			}
			if (el.type === "columns") {
				for (const c of kids) {
					const t = els[c];
					if (t !== undefined && t.type !== "column") {
						ctx.addIssue({
							code: "custom",
							path: ["elements", pid],
							message: `columns "${pid}" child "${c}" is type "${t.type}" — columns children must be column elements`,
						});
					}
				}
			}
			if (leafTypes.has(el.type) && kids.length > 0) {
				ctx.addIssue({
					code: "custom",
					path: ["elements", pid],
					message: `leaf "${pid}" (${el.type}) must not have children`,
				});
			}
		}
		// Placement: tab only under tabs, column only under columns.
		for (const [id, el] of Object.entries(els)) {
			const parentType = els[parentOf.get(id) ?? ""]?.type;
			if (el.type === "tab" && parentType !== "tabs") {
				ctx.addIssue({
					code: "custom",
					path: ["elements", id],
					message: `tab "${id}" is not inside a tabs element`,
				});
			}
			if (el.type === "column" && parentType !== "columns") {
				ctx.addIssue({
					code: "custom",
					path: ["elements", id],
					message: `column "${id}" is not inside a columns element`,
				});
			}
		}
		// Cycles: every node's ancestor walk must terminate off-loop.
		for (const id of ids) {
			const seen = new Set<string>([id]);
			let cur = id;
			while (parentOf.has(cur)) {
				cur = parentOf.get(cur)!;
				if (seen.has(cur)) {
					ctx.addIssue({
						code: "custom",
						path: ["elements", id],
						message: `cycle: "${cur}" is its own ancestor`,
					});
					break;
				}
				seen.add(cur);
			}
		}
	});

export type UiLeaf = z.infer<typeof uiLeafElementSchema>;
export type UiContainer = z.infer<typeof containerElements>;
export type UiElement = z.infer<typeof uiElementSchema>;
export type UiInput = z.infer<typeof uiInputSchema>;
export type UiLeafProps<T extends UiLeaf["type"]> = Extract<UiLeaf, { type: T }>["props"];

// ---------- type repair ----------
//
// Every rule fires only when exactly one interpretation exists — a tie
// or a guess stays broken and the model sees the tool error. `prune`
// (default on) drops elements unreachable from root; the streaming
// renderer passes prune:false so in-flight subtrees stay visible.

export interface UiNormalizeReport {
	// element ids (or "elements") whose JSON-string payload parsed to an object
	parsedProps: string[];
	// content fields moved off an element's top level into props
	hoisted: { id: string; keys: string[] }[];
	// inline child objects lifted into the elements map, id → parent
	flattened: { id: string; parent: string }[];
	// type inferred from the props key-set
	inferred: { id: string; type: string }[];
	// chart series values coerced from numeric strings
	coerced: { id: string; count: number }[];
	// array root became a synthesized stack element with this id
	synthesizedRoot: string | null;
	// the single unreferenced element became root
	inferredRoot: string | null;
	// a string "root" entry inside the map was the misplaced root pointer
	strayRoot: { value: string; action: "moved" | "dropped" } | null;
	// the whole spec was nested one level deep inside elements
	unwrapped: boolean;
	// dropped: unreachable from root (prune only)
	unreachable: string[];
}

const emptyReport = (): UiNormalizeReport => ({
	parsedProps: [],
	hoisted: [],
	flattened: [],
	inferred: [],
	coerced: [],
	synthesizedRoot: null,
	inferredRoot: null,
	strayRoot: null,
	unwrapped: false,
	unreachable: [],
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryJsonObject(text: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(text);
		return isPlainObject(v) ? v : null;
	} catch {
		return null;
	}
}

const labelize = (v: unknown): unknown => (typeof v === "string" ? { label: v } : v);

const NUMERIC = /^-?\d+(\.\d+)?$/;

// Chart series values that arrived as plain numeric strings — anything
// formatted ("$6.00", "1,234") is left alone.
function coerceChartSeries(props: Record<string, unknown>): number {
	if (!Array.isArray(props.series)) return 0;
	let count = 0;
	props.series = props.series.map((s) => {
		if (!isPlainObject(s) || !Array.isArray(s.values)) return s;
		return {
			...s,
			values: s.values.map((v) =>
				typeof v === "string" && NUMERIC.test(v) ? (count++, Number(v)) : v,
			),
		};
	});
	return count;
}

interface Candidate {
	type: string;
	schema: { safeParse(v: unknown): { success: boolean } };
	keys: readonly string[];
	prepare?: (props: Record<string, unknown>) => Record<string, unknown>;
}

const candidates: Candidate[] = [
	{ type: "text", schema: textProps, keys: ["md"] },
	{ type: "callout", schema: calloutProps, keys: ["tone", "title", "md"] },
	{ type: "stats", schema: statsProps, keys: ["items"] },
	{ type: "table", schema: tableProps, keys: ["columns", "rows"] },
	{ type: "steps", schema: stepsProps, keys: ["items"] },
	{
		type: "chart",
		schema: chartProps,
		keys: ["kind", "x", "series", "unit"],
		prepare: (p) => {
			const c = { ...p };
			coerceChartSeries(c);
			return c;
		},
	},
	{
		type: "choices",
		schema: choicesProps,
		keys: ["prompt", "options"],
		prepare: (o) => (Array.isArray(o.options) ? { ...o, options: o.options.map(labelize) } : o),
	},
	{ type: "form", schema: formProps, keys: ["fields", "submit"] },
	{ type: "html", schema: htmlProps, keys: ["title", "html"] },
	// The one inferable container — {label} names a tab. stack/tabs/
	// columns/column stay unguessable.
	{ type: "tab", schema: z.object({ label: z.string() }), keys: ["label"] },
];

// Re-type a typeless element by exact props key-set: every key must be
// known to the candidate, the candidate must validate, and the minimal
// matching key-set must be unique (a tie is no repair).
function inferType(props: Record<string, unknown>): { type: string; props: Record<string, unknown> } | null {
	const keys = Object.keys(props);
	const qualifying: { c: Candidate; prepared: Record<string, unknown> }[] = [];
	for (const c of candidates) {
		if (!keys.every((k) => c.keys.includes(k))) continue;
		const prepared = c.prepare ? c.prepare(props) : props;
		if (c.schema.safeParse(prepared).success) qualifying.push({ c, prepared });
	}
	if (qualifying.length === 0) return null;
	const min = Math.min(...qualifying.map((q) => q.c.keys.length));
	const best = qualifying.filter((q) => q.c.keys.length === min);
	if (best.length !== 1) return null;
	return { type: best[0]!.c.type, props: best[0]!.prepared };
}

export function normalizeUiInput(
	raw: unknown,
	opts?: { prune?: boolean },
): { value: unknown; report: UiNormalizeReport } {
	const report = emptyReport();
	if (!isPlainObject(raw)) return { value: raw, report };
	const out: Record<string, unknown> = { ...raw };
	if (typeof out.elements === "string") {
		const parsed = tryJsonObject(out.elements);
		if (parsed !== null) {
			out.elements = parsed;
			report.parsedProps.push("elements");
		}
	}
	// The whole spec nested one level deep: elements holds {elements,
	// root?} where the inner elements value is itself a map (a plain
	// object with no "type" — an element value would carry one).
	if (out.root === undefined && isPlainObject(out.elements)) {
		const inner = out.elements;
		if (isPlainObject(inner.elements) && !("type" in inner.elements)) {
			out.elements = inner.elements;
			if (typeof inner.root === "string") out.root = inner.root;
			if (out.title === undefined && typeof inner.title === "string")
				out.title = inner.title;
			report.unwrapped = true;
		}
	}
	if (!isPlainObject(out.elements)) return { value: out, report };
	const elements: Record<string, unknown> = { ...out.elements };

	const freeId = (base: string): string => {
		if (!(base in elements)) return base;
		for (let i = 2; ; i++) {
			const id = `${base}~${i}`;
			if (!(id in elements)) return id;
		}
	};

	const queue = Object.keys(elements);
	const processed = new Set<string>();
	const process = (id: string): void => {
		if (processed.has(id)) return;
		processed.add(id);
		const original = elements[id];
		if (!isPlainObject(original)) return;
		const el: Record<string, unknown> = { ...original };

		// props as a JSON string → parse into place
		if (typeof el.props === "string") {
			const parsed = tryJsonObject(el.props);
			if (parsed !== null) {
				el.props = parsed;
				report.parsedProps.push(id);
			}
		}

		// Content fields on the element's top level with no props → they
		// ARE the props.
		const extraKeys = Object.keys(el).filter(
			(k) => k !== "type" && k !== "props" && k !== "children",
		);
		if (extraKeys.length > 0 && !isPlainObject(el.props)) {
			const props: Record<string, unknown> = {};
			for (const k of extraKeys) {
				props[k] = el[k];
				delete el[k];
			}
			el.props = props;
			report.hoisted.push({ id, keys: extraKeys });
		}

		// Inline child objects hoist into the map as "<parent>.<index>".
		if (Array.isArray(el.children)) {
			el.children = (el.children as unknown[]).map((c, i) => {
				if (!isPlainObject(c)) return c;
				const cid = freeId(`${id}.${i}`);
				elements[cid] = c;
				report.flattened.push({ id: cid, parent: id });
				queue.push(cid);
				return cid;
			});
		}

		if (typeof el.type !== "string" && isPlainObject(el.props)) {
			const hit = inferType(el.props);
			if (hit !== null) {
				el.type = hit.type;
				el.props = hit.props;
				report.inferred.push({ id, type: hit.type });
			}
		}

		if (el.type === "chart" && isPlainObject(el.props)) {
			const n = coerceChartSeries(el.props);
			if (n > 0) report.coerced.push({ id, count: n });
		}

		elements[id] = el;
	};
	for (let i = 0; i < queue.length; i++) process(queue[i]!);

	// A string "root" entry inside the map is the misplaced root pointer
	// — a string can never be an element. Missing root → move it up;
	// same value → drop the stray; differing → no repair.
	if (typeof elements.root === "string") {
		const stray = elements.root;
		if (out.root === undefined) {
			out.root = stray;
			delete elements.root;
			report.strayRoot = { value: stray, action: "moved" };
		} else if (out.root === stray) {
			delete elements.root;
			report.strayRoot = { value: stray, action: "dropped" };
		}
	}

	// Array root → a synthesized stack element wrapping it.
	if (Array.isArray(out.root)) {
		const rid = freeId("root");
		elements[rid] = { type: "stack", children: out.root };
		out.root = rid;
		report.synthesizedRoot = rid;
	}

	// Missing root → the single unreferenced element is it.
	if (out.root === undefined) {
		const referenced = new Set<string>();
		for (const el of Object.values(elements)) {
			if (!isPlainObject(el) || !Array.isArray(el.children)) continue;
			for (const c of el.children) if (typeof c === "string") referenced.add(c);
		}
		const orphans = Object.keys(elements).filter((id) => !referenced.has(id));
		if (orphans.length === 1) {
			out.root = orphans[0]!;
			report.inferredRoot = orphans[0]!;
		}
	}

	// Prune unreachable elements — the report names what was dropped.
	if (opts?.prune !== false && typeof out.root === "string") {
		const reach = new Set<string>();
		const todo = [out.root];
		while (todo.length > 0) {
			const id = todo.pop()!;
			if (reach.has(id)) continue;
			reach.add(id);
			const el = elements[id];
			if (!isPlainObject(el) || !Array.isArray(el.children)) continue;
			for (const c of el.children) if (typeof c === "string") todo.push(c);
		}
		for (const id of Object.keys(elements)) {
			// Only element objects prune — a non-element entry (a stray
			// string, a number) is a schema violation, not unreachable
			// junk, and must stay visible to validation.
			if (!reach.has(id) && isPlainObject(elements[id])) {
				delete elements[id];
				report.unreachable.push(id);
			}
		}
	}

	out.elements = elements;
	return { value: out, report };
}
