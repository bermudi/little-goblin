// The ui tool's input schema — the component library the model builds
// interfaces from (design/app.md → Intelligent UI). Shared with the app
// client (progressive render validates partial blocks with the same
// shapes), so this module is zod only: no server imports.
//
// Two levels, no recursion — container children are leaves only. A
// recursive schema emits $ref/$defs in the wire JSON Schema, which
// OpenAI-compatible providers handle unevenly; a rejected tool schema
// breaks every app turn.

import { z } from "zod";

const md = z.string().describe("Markdown body");

const textLeaf = z.object({
	type: z.literal("text"),
	md: md.describe("Markdown text — prose inside the interface"),
});

const calloutLeaf = z.object({
	type: z.literal("callout"),
	tone: z
		.enum(["info", "warn", "success", "danger"])
		.optional()
		.describe("Emphasis tone; defaults to info"),
	title: z.string().optional().describe("Short callout heading"),
	md: md.describe("Markdown body of the callout"),
});

const statsLeaf = z.object({
	type: z.literal("stats"),
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

const tableLeaf = z.object({
	type: z.literal("table"),
	columns: z.array(z.string()).min(1).max(8).describe("Column headers, 1–8"),
	rows: z.array(z.array(z.string())).max(50).describe("Body rows; each row is one cell per column"),
});

const stepsLeaf = z.object({
	type: z.literal("steps"),
	items: z
		.array(
			z.object({
				title: z.string().describe("Step name"),
				md: md.optional().describe("Optional Markdown detail under the step"),
			}),
		)
		.min(1)
		.max(20)
		.describe("Ordered steps, 1–20"),
});

const chartLeaf = z
	.object({
		type: z.literal("chart"),
		kind: z.enum(["bar", "line"]).describe("Grouped bars or lines"),
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
	});

const choicesLeaf = z.object({
	type: z.literal("choices"),
	prompt: z.string().optional().describe("Question the options answer"),
	options: z
		.array(z.object({ label: z.string().max(80).describe("Button label") }))
		.min(2)
		.max(8)
		.describe("2–8 tappable options; a tap sends [ui] <label> as a message"),
});

const formLeaf = z
	.object({
		type: z.literal("form"),
		fields: z
			.array(
				z.object({
					name: z.string().describe("Field key sent back on submit"),
					label: z.string().describe("Visible field label"),
					kind: z.enum(["text", "number", "select"]).describe("Input kind"),
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
	});

const htmlLeaf = z.object({
	type: z.literal("html"),
	title: z.string().describe("Accessible frame title"),
	html: z
		.string()
		.max(100_000)
		.describe(
			"Self-contained document body — inline script/style only, no network, no external assets. Rendered sandboxed.",
		),
});

export const uiLeafSchema = z.discriminatedUnion("type", [
	textLeaf,
	calloutLeaf,
	statsLeaf,
	tableLeaf,
	stepsLeaf,
	chartLeaf,
	choicesLeaf,
	formLeaf,
	htmlLeaf,
]);

const tabsBlock = z.object({
	type: z.literal("tabs"),
	tabs: z
		.array(
			z.object({
				label: z.string().describe("Tab label"),
				blocks: z.array(uiLeafSchema).min(1).describe("Leaves shown on this tab"),
			}),
		)
		.min(2)
		.max(8)
		.describe("2–8 tabs"),
});

const columnsBlock = z.object({
	type: z.literal("columns"),
	columns: z
		.array(
			z.object({
				title: z.string().optional().describe("Column heading"),
				blocks: z.array(uiLeafSchema).min(1).describe("Leaves in this column"),
			}),
		)
		.min(2)
		.max(4)
		.describe("2–4 side-by-side columns"),
});

export const uiBlockSchema = z.discriminatedUnion("type", [
	...uiLeafSchema.options,
	tabsBlock,
	columnsBlock,
]);

export const uiInputSchema = z.object({
	title: z.string().optional().describe("Short heading above the interface"),
	blocks: z
		.array(uiBlockSchema)
		.min(1)
		.max(30)
		.describe("The interface, top to bottom — leaves and containers"),
});

export type UiLeaf = z.infer<typeof uiLeafSchema>;
export type UiBlock = z.infer<typeof uiBlockSchema>;
export type UiInput = z.infer<typeof uiInputSchema>;

// ---------- type repair ----------

// GLM sometimes emits a block with every field but "type" — it writes
// the discriminator last and drops it. These tables describe each
// block's declared content keys (shape minus "type") so a typeless
// object can be re-typed by exact key-set match. "Fewest declared
// keys" is the tiebreak, so keep them in sync with the schemas above.
interface Candidate {
	type: string;
	schema: { safeParse(v: unknown): { success: boolean } };
	keys: readonly string[];
	// A pre-parse value repair observed live: GLM writes choices
	// options as bare strings instead of {label} objects.
	prepare?: (obj: Record<string, unknown>) => Record<string, unknown>;
}

const labelize = (v: unknown): unknown => (typeof v === "string" ? { label: v } : v);

const leafCandidates: Candidate[] = [
	{ type: "text", schema: textLeaf, keys: ["md"] },
	{ type: "callout", schema: calloutLeaf, keys: ["tone", "title", "md"] },
	{ type: "stats", schema: statsLeaf, keys: ["items"] },
	{ type: "table", schema: tableLeaf, keys: ["columns", "rows"] },
	{ type: "steps", schema: stepsLeaf, keys: ["items"] },
	{ type: "chart", schema: chartLeaf, keys: ["kind", "x", "series", "unit"] },
	{
		type: "choices",
		schema: choicesLeaf,
		keys: ["prompt", "options"],
		prepare: (o) => (Array.isArray(o.options) ? { ...o, options: o.options.map(labelize) } : o),
	},
	{ type: "form", schema: formLeaf, keys: ["fields", "submit"] },
	{ type: "html", schema: htmlLeaf, keys: ["title", "html"] },
];
const blockCandidates: Candidate[] = [
	...leafCandidates,
	{ type: "tabs", schema: tabsBlock, keys: ["tabs"] },
	{ type: "columns", schema: columnsBlock, keys: ["columns"] },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A block that is nothing but a discriminator is a streaming fragment —
// it carries no content worth keeping.
const DROP = Symbol("ui-drop");

function repairBlock(
	obj: unknown,
	candidates: Candidate[],
	path: string,
	ctx: { inferred: { path: string; type: string }[]; dropped: number },
): unknown {
	if (!isPlainObject(obj)) return obj;
	const keys = Object.keys(obj);
	if (keys.length === 1 && keys[0] === "type") {
		ctx.dropped++;
		return DROP;
	}
	if ("type" in obj) return obj;
	const qualifying: { c: Candidate; prepared: Record<string, unknown> }[] = [];
	for (const c of candidates) {
		if (!keys.every((k) => c.keys.includes(k))) continue;
		const prepared = c.prepare ? c.prepare(obj) : obj;
		if (c.schema.safeParse({ ...prepared, type: c.type }).success) {
			qualifying.push({ c, prepared });
		}
	}
	if (qualifying.length === 0) return obj;
	const min = Math.min(...qualifying.map((q) => q.c.keys.length));
	const best = qualifying.filter((q) => q.c.keys.length === min);
	if (best.length !== 1) return obj;
	ctx.inferred.push({ path, type: best[0]!.c.type });
	return { type: best[0]!.c.type, ...best[0]!.prepared };
}

function repairChildren(
	obj: unknown,
	path: string,
	ctx: { inferred: { path: string; type: string }[]; dropped: number },
): unknown {
	if (!isPlainObject(obj)) return obj;
	const out: Record<string, unknown> = { ...obj };
	for (const key of ["tabs", "columns"] as const) {
		const group = obj[key];
		if (!Array.isArray(group)) continue;
		out[key] = group.map((member, mi) => {
			if (!isPlainObject(member) || !Array.isArray(member.blocks)) return member;
			const children: unknown[] = [];
			member.blocks.forEach((child, ci) => {
				const fixed = repairBlock(child, leafCandidates, `${path}.${key}.${mi}.blocks.${ci}`, ctx);
				if (fixed !== DROP) children.push(fixed);
			});
			return { ...member, blocks: children };
		});
	}
	return out;
}

// Best-effort repair of the model's type omissions before validation:
// typeless blocks are re-typed by exact key-set match, bare {type}
// fragments drop. Anything unmatchable passes through untouched and
// fails the real schema as before. Never mutates the input.
export function normalizeUiInput(raw: unknown): {
	value: unknown;
	inferred: { path: string; type: string }[];
	dropped: number;
} {
	const ctx = { inferred: [] as { path: string; type: string }[], dropped: 0 };
	if (!isPlainObject(raw) || !Array.isArray(raw.blocks)) {
		return { value: raw, ...ctx };
	}
	const blocks: unknown[] = [];
	raw.blocks.forEach((b, i) => {
		const path = `blocks.${i}`;
		const fixed = repairBlock(b, blockCandidates, path, ctx);
		if (fixed === DROP) return;
		blocks.push(repairChildren(fixed, path, ctx));
	});
	return { value: { ...raw, blocks }, ...ctx };
}
