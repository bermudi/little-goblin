import { asSchema, jsonSchema, tool } from "ai";
import { log } from "../../log.ts";
import { normalizeUiInput, uiInputSchema, type UiInput } from "./ui-schema.ts";

// zod 4 emits `propertyNames` for z.record's key schema — some providers
// reject the keyword outright, so the wire schema drops it. The emitted
// schema is otherwise exactly the zod conversion (invariant pinned in
// ui.test.ts: no $ref/$defs/propertyNames).
function stripPropertyNames(node: unknown): void {
	if (Array.isArray(node)) {
		for (const v of node) stripPropertyNames(v);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const o = node as Record<string, unknown>;
	delete o.propertyNames;
	for (const v of Object.values(o)) stripPropertyNames(v);
}

const wireSchema = (() => {
	const s = asSchema(uiInputSchema).jsonSchema;
	stripPropertyNames(s);
	return s;
})();

// Non-empty report fields only — the log line names what repair did.
function reportFields(report: ReturnType<typeof normalizeUiInput>["report"]) {
	return Object.fromEntries(
		Object.entries(report).filter(([, v]) =>
			Array.isArray(v) ? v.length > 0 : v !== null && v !== 0,
		),
	);
}

// Elements deep from the deepest root — the tree is guaranteed
// acyclic by validation, but the walk guards anyway since execute
// sees only validated input.
function depth(input: UiInput): number {
	const seen = new Set<string>();
	const walk = (id: string): number => {
		if (seen.has(id)) return 0;
		seen.add(id);
		const el = input.elements[id];
		if (el === undefined) return 0;
		return 1 + Math.max(0, ...(el.children ?? []).map(walk));
	};
	return Math.max(0, ...(Array.isArray(input.root) ? input.root : [input.root]).map(walk));
}

export const uiTool = () =>
	tool({
		description:
			'Show the operator an interface instead of prose, rendered inline in the goblin app. Plain text is the default — most answers should not use this. Reach for it when layout carries meaning: options compared side by side (columns), a process or plan in order (steps), numbers worth seeing at a glance (stats, chart, table), a topic with separable parts (tabs), a decision the operator makes with a tap (choices) or details to fill in (form). Use html only when the answer needs live computation or interaction the other elements cannot express — a calculator, a bill splitter, a small game: one self-contained document, inline script and style, no network, no external assets. Keep surrounding text short and never repeat in prose what the interface shows. Choices and form submits come back as a user message starting with [ui]. The interface is a flat map: "root" names the top element; "elements" maps each id to {type, props, children}, where children lists child ids — never nested objects. For several top-level elements, "root" may be a list of ids in display order — no wrapper needed. Containers: stack (a vertical group), tabs (children are tab elements, tab props {label}), columns (children are column elements, column props {title?}); stack, tab and column children may be any element, including other containers, nested as deep as needed. Every other type is a leaf with no children. Write root first, then each parent before its children; every element needs its "type" — write it first. Example: {"root":"main","elements":{"main":{"type":"stack","children":["intro","cmp"]},"intro":{"type":"text","props":{"md":"Two options."}},"cmp":{"type":"columns","children":["a","b"]},"a":{"type":"column","props":{"title":"A"},"children":["a1"]},"a1":{"type":"text","props":{"md":"…"}},"b":{"type":"column","props":{"title":"B"},"children":["b1"]},"b1":{"type":"text","props":{"md":"…"}}}}',
		inputSchema: jsonSchema<UiInput>(wireSchema, {
			validate: (value) => {
				const repaired = normalizeUiInput(value);
				const parsed = uiInputSchema.safeParse(repaired.value);
				if (!parsed.success) {
					log.warn("ui input invalid", {
						issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
						...reportFields(repaired.report),
					});
					return { success: false, error: parsed.error };
				}
				const repairs = reportFields(repaired.report);
				if (Object.keys(repairs).length > 0) {
					log.info("ui input repaired", repairs);
				}
				return { success: true, value: parsed.data };
			},
		}),
		execute: async (input) => {
			const elements = Object.values(input.elements);
			const htmlBytes = elements
				.filter((e) => e.type === "html")
				.reduce((n, e) => n + Buffer.byteLength(e.props.html), 0);
			log.info("ui shown", {
				elements: elements.length,
				kinds: [...new Set(elements.map((e) => e.type))].sort(),
				depth: depth(input),
				...(htmlBytes > 0 ? { htmlBytes } : {}),
			});
			return "shown";
		},
	});
