// UiPart — the tool-part boundary for "ui". The part's input IS the
// interface: streaming input renders the elements that have arrived
// (root first, pending ids as skeletons, orphans in arrival order
// while root is unwritten; html mounts only once complete), complete
// input renders all-or-nothing — a bad payload falls back to the
// generic tool row, never a blank.

import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import type { ReactNode } from "react";
import {
	normalizeUiInput,
	uiElementSchema,
	uiInputSchema,
	type UiElement,
} from "../../../src/agent/tools/ui-schema.ts";
import type { MarkdownNoteContext } from "../markdown.tsx";
import { Skeleton } from "../tools/bits.tsx";
import { ToolRun } from "../tools/mod.tsx";
import { Node, Surface, type UiActionProps, type UiRender } from "./blocks.tsx";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A mid-stream payload never passes uiInputSchema's superRefine — the
// streaming sanitizer owns its own bounds. The element cap mirrors the
// complete-input schema's 200 max; the depth cap bounds the walk (and
// React's recursive render) against a degenerate id chain. Beyond
// either cap an element is dropped exactly like any other invalid one
// — skeleton/nothing — and the completed part is still validated
// server-side, so the truncation is transient, never durable.
const STREAM_ELEMENT_CAP = 200;
const STREAM_DEPTH_CAP = 100;

function StreamingSurface({ input, ...note }: { input: unknown } & MarkdownNoteContext) {
	// Tail semantics ride the RAW write order (the model's last-open
	// element), while the map itself is the normalized one — hoisted
	// inline children are complete objects anyway.
	const rawIn = isPlainObject(input) ? input : {};
	const rawElements = isPlainObject(rawIn.elements) ? rawIn.elements : {};
	const tailId = Object.keys(rawElements).at(-1);
	const normalized = normalizeUiInput(input, { prune: false }).value;
	const norm = isPlainObject(normalized) ? normalized : {};
	const normElements = isPlainObject(norm.elements) ? norm.elements : {};
	const title = typeof norm.title === "string" ? norm.title : null;

	// The map Node reads holds only schema-valid elements; invalid ones
	// fall to the render wrapper's skeleton/nothing split below. Arrival
	// order, capped at STREAM_ELEMENT_CAP.
	const valid: Record<string, UiElement> = {};
	for (const [id, v] of Object.entries(normElements).slice(0, STREAM_ELEMENT_CAP)) {
		const parsed = uiElementSchema.safeParse(v);
		if (parsed.success) valid[id] = parsed.data;
	}

	// A partial map can hold cycles or shared children — sanitize the
	// edges ONCE, before any render: DFS from root (or from each orphan
	// while root is unwritten), dropping child refs that point at an
	// ancestor (a cycle) or at a node another parent already claimed,
	// and refusing to descend past STREAM_DEPTH_CAP — a chain that deep
	// is degenerate output, not a UI. The render below then keeps no
	// per-render mutable state — Tabs re-rendering on a click must reuse
	// the closure safely. The ancestors set is one shared path set
	// (add/discard around each recursion), never a copy per level.
	const claimed = new Set<string>();
	const kept = new Map<string, string[]>();
	const visit = (id: string, ancestors: Set<string>, depth: number): void => {
		const el = Object.hasOwn(valid, id) ? valid[id] : undefined;
		if (el === undefined) return;
		const kids: string[] = [];
		if (depth < STREAM_DEPTH_CAP) {
			for (const c of el.children ?? []) {
				if (ancestors.has(c) || claimed.has(c)) continue;
				claimed.add(c);
				kids.push(c);
			}
		}
		kept.set(id, kids);
		ancestors.add(id);
		for (const c of kids) visit(c, ancestors, depth + 1);
		ancestors.delete(id);
	};
	const roots: string[] = Array.isArray(norm.root)
		? norm.root.filter((r): r is string => typeof r === "string")
		: typeof norm.root === "string"
			? [norm.root]
			: [];
	if (roots.length === 0) {
		const referenced = new Set<string>();
		for (const v of Object.values(normElements)) {
			if (!isPlainObject(v) || !Array.isArray(v.children)) continue;
			for (const c of v.children) if (typeof c === "string") referenced.add(c);
		}
		// Orphan roots in arrival order, bounded by the element cap —
		// past it `valid` holds nothing more to render anyway.
		for (const id of Object.keys(normElements)) {
			if (roots.length >= STREAM_ELEMENT_CAP) break;
			if (!referenced.has(id)) roots.push(id);
		}
	}
	// Claim every root before visiting any — a root id that is also a
	// child then renders once, at top level, with its subtree intact.
	for (const id of roots) claimed.add(id);
	for (const id of roots) visit(id, new Set([id]), 0);
	const elements: Record<string, UiElement> = {};
	for (const [id, el] of Object.entries(valid)) {
		const k = kept.get(id);
		elements[id] = k === undefined ? el : { ...el, children: k };
	}

	const render: UiRender = (id) => {
		const el = Object.hasOwn(elements, id) ? elements[id] : undefined;
		if (el === undefined) {
			if (!Object.hasOwn(normElements, id)) return <Skeleton key={id} />;
			// Present but invalid: only the still-writing tail gets a
			// skeleton; earlier invalids are skipped, never skeletons.
			return id === tailId ? <Skeleton key={id} /> : null;
		}
		return <Node key={id} id={id} elements={elements} render={render} streaming {...note} />;
	};

	const body: ReactNode[] = roots.map((id) => render(id));
	return (
		<div className="ui">
			{title !== null && <div className="ui-title">{title}</div>}
			{body.every((b) => b === null) && <Skeleton />}
			{body}
		</div>
	);
}

export function UiPart({
	part,
	onAction,
	busy,
	streaming,
	messages,
	...note
}: {
	part: ToolUIPart | DynamicToolUIPart;
	messages?: readonly UIMessage[] | undefined;
} & UiActionProps) {
	switch (part.state) {
		case "input-streaming":
			return <StreamingSurface input={part.input} {...note} />;
		case "input-available":
		case "output-available": {
			const parsed = uiInputSchema.safeParse(normalizeUiInput(part.input).value);
			if (!parsed.success) return <ToolRun part={part} />;
			return (
				<Surface
					input={parsed.data}
					onAction={onAction}
					busy={busy}
					streaming={streaming}
					messages={messages}
					{...note}
				/>
			);
		}
		default:
			// output-error / output-denied / approval states — the
			// generic row's own faces.
			return <ToolRun part={part} />;
	}
}
