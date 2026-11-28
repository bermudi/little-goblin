// The reviewer's System One gate — its question set, state builder, and
// budgets. Pure function of a completed turn; depends only on the
// evidence types, never on reviewer internals, so the class in
// reviewer.ts can import it without cycling.

import type { CompletedTurn } from "./reviewer-evidence.ts";
import type { System1Question } from "./system1.ts";

export const GATE_QUESTIONS: Record<string, System1Question> = {
	correction: {
		type: "noul",
		instructions:
			"Did the operator correct how the assistant did something — point out a mistake, restate a preference, or redirect the approach?",
		criteria: {
			true: "The operator corrected a mistake, restated a preference, or redirected the approach",
			false: "No correction: the operator asked, answered, or acknowledged without redirecting",
		},
	},
	procedure: {
		type: "noul",
		instructions:
			"Did the turn carry out a repeatable multi-step procedure — a sequence of tool calls or steps worth saving as a reusable skill?",
		criteria: {
			true: "A repeatable multi-step procedure was carried out",
			false: "A one-off answer, chat, or single-step task with nothing worth reusing",
		},
	},
};

export const REUSE_QUESTION: Record<string, System1Question> = {
	reuse: {
		type: "noul",
		instructions: "Is this operator likely to need this same procedure again?",
		criteria: {
			true: "The task is likely to come back: it runs on a schedule, belongs to the operator's routine, or handles a kind of request the operator will make again",
			false: "One-off: an investigation, comparison or question about one specific thing, with no reason to expect the same task again",
		},
	},
};
export const DEFAULT_REUSE_THRESHOLD = 0.6;

// The decision model's context is 32k tokens — the state stays well
// under it. Operator text reads tail-first (a correction lands in the
// latest message); the reply reads head-first. Names and counts only —
// a heavy gate is a non-goal.
export const MAX_OPERATOR_CHARS = 10_000;
export const MAX_REPLY_CHARS = 12_000;
export const FALLBACK_TOOL_CALLS = 8;

export function buildGateState(
	turn: Pick<CompletedTurn, "operatorTexts" | "replyText" | "toolNames">,
): string {
	const counts = new Map<string, number>();
	for (const name of turn.toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
	const tools = [...counts.entries()]
		.map(([name, n]) => (n === 1 ? name : `${name} ×${n}`))
		.join(", ");
	return [
		"operator:",
		turn.operatorTexts.join("\n---\n").slice(-MAX_OPERATOR_CHARS),
		"",
		"assistant reply:",
		turn.replyText.slice(0, MAX_REPLY_CHARS),
		"",
		`tools: ${tools === "" ? "(none)" : tools} (${turn.toolNames.length} total)`,
	].join("\n");
}
