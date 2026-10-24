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
	const root = typeof norm.root === "string" ? norm.root : null;

	// The map Node reads holds only schema-valid elements; invalid ones
	// fall to the render wrapper's skeleton/nothing split below.
	const elements: Record<string, UiElement> = {};
	for (const [id, v] of Object.entries(normElements)) {
		const parsed = uiElementSchema.safeParse(v);
		if (parsed.success) elements[id] = parsed.data;
	}

	const visited = new Set<string>();
	const render: UiRender = (id) => {
		// A partial map can hold cycles or shared children — a revisit
		// renders nothing and must never recurse forever.
		if (visited.has(id)) return null;
		visited.add(id);
		const el = elements[id];
		if (el === undefined) {
			if (!(id in normElements)) return <Skeleton key={id} />;
			// Present but invalid: only the still-writing tail gets a
			// skeleton; earlier invalids are skipped, never skeletons.
			return id === tailId ? <Skeleton key={id} /> : null;
		}
		return <Node key={id} id={id} elements={elements} render={render} streaming {...note} />;
	};

	let body: ReactNode[];
	if (root !== null) {
		body = [render(root)];
	} else {
		// No root yet: unreferenced elements in arrival order.
		const referenced = new Set<string>();
		for (const v of Object.values(normElements)) {
			if (!isPlainObject(v) || !Array.isArray(v.children)) continue;
			for (const c of v.children) if (typeof c === "string") referenced.add(c);
		}
		body = Object.keys(normElements)
			.filter((id) => !referenced.has(id))
			.map((id) => render(id));
	}
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
