// UiPart — the tool-part boundary for "ui" (design/app.md →
// Intelligent UI). The part's input IS the interface: streaming input
// renders every block that validates with a skeleton tail (html mounts
// only once complete), complete input renders all-or-nothing — a bad
// payload falls back to the generic tool row, never a blank.

import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import {
	normalizeUiInput,
	uiBlockSchema,
	uiInputSchema,
} from "../../../src/agent/tools/ui-schema.ts";
import { Skeleton } from "../tools/bits.tsx";
import { ToolRun } from "../tools/mod.tsx";
import { Block, Surface, type UiActionProps } from "./blocks.tsx";

function StreamingSurface({
	input,
	token,
	noteProjectId,
	onOpenNote,
}: { input: unknown } & Pick<UiActionProps, "token" | "noteProjectId" | "onOpenNote">) {
	const md = { token, noteProjectId, onOpenNote };
	const rawIn = (typeof input === "object" && input !== null ? input : {}) as Record<
		string,
		unknown
	>;
	const normalized = normalizeUiInput(input).value;
	const raw = (typeof normalized === "object" && normalized !== null ? normalized : {}) as Record<
		string,
		unknown
	>;
	const title = typeof raw.title === "string" ? raw.title : null;
	const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
	// A bare {type} tail is dropped as a fragment by normalize — but
	// mid-stream it IS the in-flight block, so it still gets a skeleton.
	const rawTail = Array.isArray(rawIn.blocks) ? rawIn.blocks.at(-1) : undefined;
	const tailFragment =
		typeof rawTail === "object" &&
		rawTail !== null &&
		!Array.isArray(rawTail) &&
		Object.keys(rawTail).length === 1 &&
		"type" in rawTail;
	return (
		<div className="ui">
			{title !== null && <div className="ui-title">{title}</div>}
			{blocks.length === 0 && !tailFragment && <Skeleton />}
			{blocks.map((b, i) => {
				const last = i === blocks.length - 1;
				const parsed = uiBlockSchema.safeParse(b);
				// Only the tail may legitimately be mid-write — earlier
				// invalid blocks are skipped, never skeletons.
				if (!parsed.success) return last && !tailFragment ? <Skeleton key={i} /> : null;
				// streaming pins html leaves to skeletons at any depth.
				return <Block key={i} block={parsed.data} streaming {...md} />;
			})}
			{tailFragment && <Skeleton />}
		</div>
	);
}

export function UiPart({
	part,
	onAction,
	busy,
	messages,
	token,
	noteProjectId,
	onOpenNote,
}: {
	part: ToolUIPart | DynamicToolUIPart;
	messages?: readonly UIMessage[] | undefined;
} & UiActionProps) {
	switch (part.state) {
		case "input-streaming":
			return (
				<StreamingSurface
					input={part.input}
					token={token}
					noteProjectId={noteProjectId}
					onOpenNote={onOpenNote}
				/>
			);
		case "input-available":
		case "output-available": {
			const parsed = uiInputSchema.safeParse(normalizeUiInput(part.input).value);
			if (!parsed.success) return <ToolRun part={part} />;
			return (
				<Surface
					input={parsed.data}
					onAction={onAction}
					busy={busy}
					messages={messages}
					token={token}
					noteProjectId={noteProjectId}
					onOpenNote={onOpenNote}
				/>
			);
		}
		default:
			// output-error / output-denied / approval states — the
			// generic row's own faces.
			return <ToolRun part={part} />;
	}
}
