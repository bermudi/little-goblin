// The picked-row highlight's transcript half: a choices tap posts
// "[ui] <label>" as an ordinary user message, so the latest such
// message whose label the surface itself offers IS the picked label —
// the highlight re-derives on reload with nothing stored
// (design/app.md → Intelligent UI: local state stays in React).

import type { UIMessage } from "ai";
import type { UiBlock } from "../../../src/agent/tools/ui-schema.ts";

// Every choices label a surface offers — top level and inside
// containers (the highlight matches table first cells against these).
export function choiceLabels(blocks: readonly UiBlock[]): string[] {
	const out: string[] = [];
	for (const b of blocks) {
		if (b.type === "choices") {
			for (const o of b.options) out.push(o.label);
		} else if (b.type === "tabs") {
			for (const t of b.tabs) out.push(...choiceLabels(t.blocks));
		} else if (b.type === "columns") {
			for (const c of b.columns) out.push(...choiceLabels(c.blocks));
		}
	}
	return out;
}

// Newest-first scan; user messages only (an assistant echoing a label
// in prose must not move the highlight).
export function derivePick(
	messages: readonly UIMessage[],
	labels: readonly string[],
): string | null {
	if (labels.length === 0) return null;
	const offered = new Set(labels);
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		for (const p of m.parts) {
			if (p.type !== "text") continue;
			const match = /^\[ui\] (.+)$/.exec(p.text);
			if (match !== null && offered.has(match[1]!)) return match[1]!;
		}
	}
	return null;
}
